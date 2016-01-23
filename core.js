'use strict';

var pmx = require('pmx');
var os = require('os');
var pm2 = require('pm2');
var fs = require('fs');
var path = require('path');
var extend = require('extend');
var Scribe = require('scribe-js');
var async = require('async');
var esc = require('shell-escape');
var child = require('child_process');
var selectn = require('selectn');

var WIN32 = os.platform() === 'win32';

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
  socket: !!process.env.pmx_module,
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
        queue: {label: 'queue', query: {'transient.tags': {$in: ['queue']}}}
      }
    }
  },
  native: {},
  debug: false
});

var queue = async.queue(function (task, callback) {
  var b = process.hrtime();
  console.tag('queue').log('Started ' + task.name);

  function next() {
    var t = process.hrtime(b);
    console.tag('queue').log('Finished ' + task.name + ' (' + Number(t[0] * 1000 + t[1] / 1000000).toFixed(3) + 'ms)');
    callback.apply(queue, arguments);
  }

  if (typeof task.func !== 'function') {
    return next();
  }

  if (task.func.length) {
    task.func(next);
  } else {
    task.func();
    next();
  }
}, 1);

queue.drain = function () {
  console.tag('queue').log('All items have been processed');
};

var defer = function defer(func, name) {
  queue.push({func: func, name: name});
  console.tag('queue').log('Deferred task ' + name + ', Queue ' + queue.length());
};

function exec(p, cb, opts) {
  opts = opts || {};

  var log = opts.log !== false;
  var args = opts.args || [];
  args = Array.isArray(args) ? args : [args];

  p += ' ' + esc(args).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/"/g, '\\"');

  console.tag('exec').info(p);

  if (typeof cb !== 'function') {
    var res = child.spawnSync(WIN32 ? 'cmd' : 'bash', [], Object.assign(opts, {input: p}));
    return {code: res.status, output: res.stdout.toString('utf8') + res.stderr.toString('utf8')};
  }

  var out = '';
  var terminal = child.spawn(WIN32 ? 'cmd' : 'bash', [], Object.assign(opts, {encoding: 'buffer'}));

  terminal.stdout && terminal.stdout.on('data', function (data) {
    data = data.toString('utf8');
    if (!data.trim()) return;
    if (log) console.tag('exec').log(data);
    out += data;
  });

  terminal.stderr && terminal.stderr.on('data', function (data) {
    data = data.toString('utf8');
    if (!data.trim()) return;
    if (log) console.tag('exec').log(data);
    out += data;
  });

  terminal.on('exit', function (code) {
    return cb(code, out);
  });

  setTimeout(function () {
    terminal.stdin.write(p + '\n');
    terminal.stdin.end();
  }, 1000);

  return terminal;
}

function available(port) {
  var system = ecosystem();

  for (var m in system) {
    if (system.hasOwnProperty(m) && system[m].port === port) {
      return false;
    }
  }

  return true;
}

function save(ctx) {
  var system = ecosystem();
  system[ctx.id] = ctx;
  ecosystem(system);
  return ctx;
}

function ecosystem(system) {
  var ecofile = conf.dir ? path.join(conf.dir, 'ecosystem.json') : path.join(__dirname, '/../../ecosystem.json');

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
      var cpy = extend(true, {}, system);

      for (var s in cpy) {
        if (cpy.hasOwnProperty(s)) {
          delete cpy[s].config; // do not save the config
        }
      }

      console.tag('ecosystem').log(cpy);

      var out = JSON.stringify(cpy, null, 4);
      fs.writeFileSync(ecofile, out, {encoding: 'utf8'});
    } catch (e) {
      console.tag('ecosystem').error(e);
    }
  }
}

function resolve(uri, branch, opts) {
  opts = extend(true, {scale: null, mode: false, commit: null}, opts);

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

    var cwd = conf.dir ? path.join(conf.dir, 'repos') : path.join(__dirname, '/../../repos'); // to root ~/.pm2
    var dir = path.join(cwd, folder);

    context = {uri: uri, cwd: cwd, id: folder, folder: folder, dir: dir, branch: branch, port: port};
  }

  if (typeof opts.commit === 'string') {
    context.commit = opts.commit;
  }

  var maxInstances = parseInt(isNaN(conf.maxInstances) || conf.maxInstances <= 0 ? os.cpus().length : conf.maxInstances);
  var scale = typeof opts.scale !== 'number' || isNaN(opts.scale) ? (context.scale || 1) : opts.scale;

  context.mode = mode;
  context.scale = Math.min(Math.abs(scale), maxInstances);

  console.log(context.scale);

  save(context);

  return context;
}

function env(ctx, event, extra) {
  extra = extra || {};

  var config = configuration(ctx);
  var mode = ctx.mode || 'release';

  var x = Object.assign({}, process.env, {
        BRANCHOFF_PORT: ctx.port,
        BRANCHOFF_CWD: ctx.dir,
        BRANCHOFF_BRANCH: ctx.branch,
        BRANCHOFF_MODE: ctx.mode || 'release',
        BRANCHOFF_NAME: ctx.id,
        BRANCHOFF_SCALE: ctx.instances, // FIXME
        BRANCHOFF_EXEC_MODE: ctx.execMode // FIXME
      }, selectn('env.default', config),
      selectn('env.' + event, config),
      selectn('env.mode.default', config),
      selectn('env.mode.' + mode, config),
      selectn('env.mode.' + mode + '@' + event, config),
      selectn('env.branch.default', config),
      selectn('env.branch.' + ctx.branch, config),
      selectn('env.branch.' + ctx.branch + '@' + event, config),
      selectn('env.branch.' + ctx.branch + '#' + mode, config),
      selectn('env.branch.' + ctx.branch + '#' + mode, config),
      selectn('env.branch.' + ctx.branch + '#' + mode + '@' + event, config),
      selectn('env.branch.' + ctx.uri, config),
      selectn('env.branch.' + ctx.uri + '^' + ctx.branch, config),
      selectn('env.branch.' + ctx.uri + '^' + ctx.branch + '@' + event, config),
      selectn('env.branch.' + ctx.uri + '^' + ctx.branch + '#' + mode, config),
      selectn('env.branch.' + ctx.uri + '^' + ctx.branch + '#' + mode, config),
      selectn('env.branch.' + ctx.uri + '^' + ctx.branch + '#' + mode + '@' + event, config),
      extra);

  //console.tag('env').log(x);

  return x;
}

function selectExists(paths) {
  for (var i = 0; i < paths.length; i++) {
    try {
      var t = fs.statSync(paths[i][0]);
      if (!t.isDirectory()) {
        return paths[i];
      }
    } catch (e) {
      // ignore
    }
  }

  throw new Error('No files ' + paths.join(' '));
}

function trigger(ctx, event, cb, args, opts) {
  configuration(ctx);

  try {
    var fp = selectExists([
      [path.join(ctx.dir, 'branchoff@' + event), ctx.dir],
      [path.join(ctx.dir, ctx.config.hooksDir || 'hooks', event), path.join(ctx.dir, ctx.config.hooksDir || 'hooks')]
    ]);

    var runScript = ['cd', fp[1], '&&', '.', fp[0]].join(' ');

    return exec(runScript, cb, Object.assign(opts || {}, {args: args, env: env(ctx, event)}));
  } catch (e) {
    console.tag('trigger').error(e);
    var res = {code: 0, output: 'No file'};
    return cb === true ? res : cb(res.code, res.output);
  }
}

function create(ctx, cb, commit) {
  var createDir = ["mkdir -p", ctx.cwd].join(" ");
  var clone = ["cd", ctx.cwd, "&& git config --global credential.helper store && git clone -b " + ctx.branch, "--single-branch", ctx.uri, ctx.dir].join(" ");
  var extra = 'pwd';

  commit = commit || ctx.commit;

  if (typeof commit === 'string' && commit.toLowerCase() !== 'latest') {
    extra = 'cd ' + ctx.dir + ' && git reset --hard ' + commit;
  }

  exec([createDir, clone, extra].join(' && '), cb);
}

function update(ctx, cb, commit) {
  configuration(ctx);

  var pull = ["cd", ctx.dir, "&& git config credential.helper store && git reset --hard && git pull --rebase"].join(" ");
  var extra = ' && pwd';

  commit = commit || ctx.commit;

  if (typeof commit === 'string' && commit.toLowerCase() !== 'latest') {
    extra = ' && cd ' + ctx.dir + ' && git reset --hard ' + commit;
  }

  exec(pull + extra, cb);
}

function destroy(ctx, cb) {
  configuration(ctx);

  var name = [ctx.port, ctx.branch, ctx.mode].join('-');

  console.tag('destroy').log(ctx);

  function close(err) {
    var removeDir = ["rm -rf", ctx.dir].join(" ");
    exec(removeDir, true);

    var system = ecosystem();
    delete system[ctx.id];
    ecosystem(system);

    cb(err);
  }

  console.tag('destroy').log('Deleting...', name);

  pm2.connect(function (err) {
    if (err) {
      console.tag('destroy').error(err);
      return close(err);
    }

    pm2.stop(name, function (err) {
      if (err) {
        console.tag('destroy').error(err);
        return close(err);
      }

      pm2.delete(name, function (err) {
        if (err) {
          console.tag('destroy').error(err);
        }

        close(err);
      });
    });
  });
}

/**
 * Second level resolver
 *
 * @param ctx
 * @returns {*}
 */
function configuration(ctx) {
  if (typeof ctx.config === 'object') {
    return ctx.config;
  }

  var config = {};

  try {
    config = JSON.parse(fs.readFileSync(path.join(ctx.dir, "branchoff@config"), {encoding: 'utf8'}));
  } catch (e) {
    try {
      config = JSON.parse(fs.readFileSync(path.join(ctx.dir, ".branchoffrc"), {encoding: 'utf8'}));
    } catch (e) {
      console.tag('start').error("Reverting to default config");
      console.tag('start').error(e);
    }
  }

  ctx.config = config;

  var mode = ctx.mode || 'release';
  var port =
      selectn('preferPort.branch.' + ctx.uri + '^' + ctx.branch + '#' + mode, config) ||
      selectn('preferPort.branch.' + ctx.uri + '^' + ctx.branch, config) ||
      selectn('preferPort.branch.' + ctx.branch + '#' + mode, config) ||
      selectn('preferPort.branch.' + ctx.branch, config) ||
      selectn('preferPort.branch.' + ctx.uri, config) ||
      selectn('preferPort.branch.default', config) ||
      selectn('preferPort.mode.' + mode, config) ||
      selectn('preferPort', config);

  // FIXME
  ctx.instances = selectn('pm2.instances', config) || ctx.scale;
  ctx.execMode = selectn('pm2.exec_mode', config) || 'cluster';

  if (typeof port === 'number' && !isNaN(port) && available(port)) {
    ctx.port = port;
    save(ctx);
  }

  return config;
}

function start(ctx, cb) {
  console.tag('start').log('Attempting to start ' + ctx.id);

  var config = configuration(ctx);
  var name = [ctx.port, ctx.branch, ctx.mode].join('-');

  config = extend(true, {}, {
    script: './bin/www',
    restart_delay: 10000,
    watch: false,
    min_uptime: "20s",
    max_restarts: 3,
    error_file: ctx.dir + '/out.log',
    out_file: ctx.dir + '/out.log'
  }, selectn('pm2', config), {
    name: name,
    cwd: ctx.dir,
    env: env(ctx, 'start')
  });

  config = extend(true, config, {
    exec_mode: ctx.execMode,
    instances: ctx.instances
  });

  console.tag('start').log(config);
  console.tag('start').log(exec(['cd', ctx.dir, '&& ls -l'].join(' '), true).output);

  pm2.connect(function (err) {
    if (err) {
      console.tag('start').error(err);
      return cb(err);
    }

    console.tag('start').log('PM2 connected');

    pm2.delete(name, function () {
      console.tag('start').log('PM2 delete');
      pm2.start(config, function (err) {
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

function accept(uri, branch) {
  if (conf.uris) {
    uri = String(uri).trim();
    var uris = String(conf.uris).split(',');
    if (uris.indexOf(uri) < 0) {
      return false;
    }
  }

  if (conf.branches) {
    branch = String(branch).trim();
    var branches = String(conf.branches).split(',');
    if (branches.indexOf(branch) < 0) {
      return false;
    }
  }

  return true;
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
  env: env,
  defer: defer,
  available: available,
  configuration: configuration,
  save: save,
  accept: accept,
  conf: conf,
  console: console
};