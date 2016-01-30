var pmx = require('pmx');
var os = require('os');
var pm2 = require('pm2');
var fs = require('fs');
var path = require('path');
var extend = require('extend');
var Scribe = require('scribe-js');
var async = require('async');
var shell = require('shelljs');

var conf = pmx.initModule({
  widget: {
    type: 'generic',
    theme: ['#111111', '#1B2228', '#807C7C', '#807C7C'],
    el: {
      probes: false,
      actions: false
    },
    block: {
      actions: false,
      issues: false,
      meta: false,
      cpu: false,
      mem: false,
      main_probes: ['Port', 'Start', 'End']
    }
  }
});

var console = new Scribe(process.pid, {
  name: 'BranchOff',
  mongo: false,
  basePath: 'scribe/',
  socketPort: conf.socketPort,
  inspector: {
    pre: false,
    callsite: false
  },
  web: {
    router: {
      username: 'build',
      password: 'build',
      authentication: false,
      sessionSecret: 'scribe-session',
      useBodyParser: true,
      useSession: true
    },
    client: {
      port: conf.port,
      socketPorts: [conf.socketPort],
      exposed: {
        all: {label: 'all', query: {expose: {$exists: true}}},
        error: {label: 'error', query: {expose: 'error'}},
        express: {label: 'express', query: {expose: 'express'}},
        info: {label: 'info', query: {expose: 'info'}},
        log: {label: 'log', query: {expose: 'log'}},
        warn: {label: 'warn', query: {expose: 'warn'}},
        trace: {label: 'trace', query: {expose: 'trace'}},
        timing: {label: 'time', query: {expose: 'timing'}},
        user: {label: 'user', query: {'transient.tags': {$in: ['USER ID']}}}
      }
    }
  },
  native: {},
  debug: false
});

var queue = async.queue((task, callback)=> {
  if (typeof task !== 'function') {
    return callback();
  }

  if (task.length) {
    task(callback);
  } else {
    task();
    callback();
  }
}, 1);

queue.drain = function () {
  console.tag('queue').log('all items have been processed');
};

var defer = task => {
  queue.push(task);
  console.tag('queue').log('Deferred tasks', queue.length());
};

function exec(p, cb) {
  console.tag('exec').info(p);

  if (cb === true) {
    return shell.exec(p);
  }

  var out = '';
  var child = shell.exec(p, {
    async: true,
    silent: true
  });

  child.stdout.on('data', data => {
    console.tag('exec').log(data);
    out += data;
  });

  child.stderr.on('data', data => {
    console.tag('exec').log(data);
    out += data;
  });

  child.on('exit', code => cb(code, out));
}

function ecosystem(system) {
  var ecofile = conf.dir || path.join(__dirname, '/../../ecosystem.json');
  if (!arguments.length && !system) {
    try {
      system = JSON.parse(fs.readFileSync(ecofile, {encoding: 'utf8'}));
      if (typeof system !== 'object') return {};
      return system;
    } catch (e) {
      return {};
    }
  } else {
    try {
      var out = JSON.stringify(system, null, 4);
      //console.tag('ecosystem', 'write').log(out);
      fs.writeFileSync(ecofile, out, {encoding: 'utf8'});
    } catch (e) {
      // ignore
    }
  }
}

function resolve(uri, branch, opts) {
  opts = extend(true, {scale: null, mode: false}, opts);

  var mode = opts.mode || '';
  var system = ecosystem();
  var folder = (uri + branch + mode).replace(/[^a-zA-Z0-9\-]/g, '');
  var id = folder;
  var start = conf.start;
  var end = conf.end;
  var port = start;
  var context;

  if (system[id]) {
    context = system[id]; // return the context
  } else {

    nextPort: for (var i = start; i < end; i++) {
      for (var m in system) {
        if (system.hasOwnProperty(m) && system[m].port === i) {
          continue nextPort;
        }
      }

      port = i;
      break;
    }

    var cwd = conf.dir || path.join(__dirname, '/../../repos'); // to root ~/.pm2
    var dir = path.join(cwd, folder);

    context = {uri: uri, cwd: cwd, id: folder, folder: folder, dir: dir, branch: branch, port: port};
  }

  var maxInstances = parseInt(isNaN(conf.maxInstances) || conf.maxInstances <= 0 ? os.cpus().length : conf.maxInstances);

  context.mode = mode;
  context.scale = Math.abs(Math.min(Math.abs(parseInt(typeof opts.scale !== 'number' ? 1 : opts.scale)), maxInstances));

  system[id] = context;

  ecosystem(system);

  return context;
}

function trigger(ctx, event, cb, args) {
  args = args || [];
  args = Array.isArray(args) ? args : [args];

  var fp = path.join(ctx.dir, 'branchoff@' + event);

  console.tag('trigger').log(fp, args);

  try {
    if (fs.statSync(fp)) {
      var runScript = ['cd', ctx.dir, '&&', '.', './branchoff@' + event]
          .concat(args.map(a => "'" + a.replace(/'/g, "\\'") + "'")).join(' ');
      return exec(runScript, cb);
    }
  } catch (e) {
    console.tag('trigger').error(e);
    var res = {code: 0, output: 'No file'};
    return cb === true ? res : cb(res.code, res.output);
  }
}

function create(ctx, cb) {
  var createDir = ["mkdir -p", ctx.cwd].join(" ");
  var clone = ["cd", ctx.cwd, "&& git config --global credential.helper store && git clone -b " + ctx.branch,
    "--single-branch", ctx.uri, ctx.dir].join(" ");

  exec([createDir, clone].join(' && '), cb);
}

function update(ctx, cb) {
  var pull = ["cd", ctx.dir, "&& git config credential.helper store && git reset --hard && git pull -f"].join(" ");

  exec(pull, cb);
}

function destroy(ctx, cb) {
  var name = [ctx.port, ctx.branch, ctx.mode].join('-');

  var system = ecosystem();
  delete system[ctx.id];
  ecosystem(system);

  function del() {
    var removeDir = ["rm -rf", ctx.dir].join(" ");
    exec(removeDir, ()=>0);
  }

  pm2.connect(function (err) {
    if (err) {
      console.tag('destroy').error(err);
      del();
      return cb(err);
    }
    pm2.delete(name, err => {
      if (err) {
        console.tag('destroy').error(err);
        del();
        return cb(err);
      }

      del();
      cb();
    });
  });
}

function start(ctx, cb) {
  console.tag('start').log('Attempting to start ' + ctx.id);

  var config = {};

  try {
    config = JSON.parse(fs.readFileSync(ctx.dir + `/branchoff@config`, {encoding: 'utf8'}))
  } catch (e) {
    console.tag('start').error("Reverting to default config");
    console.tag('start').error(e);
  }

  pm2.connect(function (err) {
    if (err) return cb(err);

    console.tag('start').log('PM2 connected');

    var name = [ctx.port, ctx.branch, ctx.mode].join('-');

    config = extend(true, {}, {
      script: `./bin/www`,
      env: {}
    }, config.pm2 || {}, {
      name: name,
      cwd: `${ctx.dir}`,
      error_file: `${ctx.dir}/out.log`,
      out_file: `${ctx.dir}/out.log`,
      env: {
        BRANCHOFF_PORT: ctx.port,
        BRANCHOFF_CWD: ctx.dir,
        BRANCHOFF_BRANCH: ctx.branch,
        BRANCHOFF_NAME: ctx.id
      }
    });

    var exec_mode = config.exec_mode || 'cluster';
    var instances = config.instances || ctx.scale;

    config = extend(true, config, {
      exec_mode: exec_mode,
      instances: instances
    });

    console.tag('start').log(config);

    pm2.delete(name, () => {
      console.tag('start').log('PM2 delete');
      pm2.start(config, err => {
        if (err) {
          console.tag('start').error(err);
          return cb(err);
        }
        pm2.disconnect();
        if (err) {
          console.tag('start').error(err);
          return cb(err);
        }
        console.tag('start').log("Started process: " + name);
        cb();
      });
    });
  });
}

module.exports = {
  exec: exec,
  start: start,
  ecosystem: ecosystem,
  resolve: resolve,
  trigger: trigger,
  create: create,
  update: update,
  destroy: destroy,
  defer: defer,
  conf: conf,
  console: console
};