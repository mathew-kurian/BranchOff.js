var express = require('express');
var pmx = require('pmx');
var async = require('async');
var Hook = require('github-webhook-handler');
var events = require('github-webhook-handler/events');
var pm2 = require('pm2');
var fs = require('fs');
var shell = require('shelljs');
var path = require('path');
var bodyParser = require('body-parser');
var extend = require('extend');
var os = require('os');
var Scribe = require('scribe-js');

// workflow
// create: <clone{test}, test, fail> OR <clone{test}, test, ok, clone, run>
// update: <clone{test}, test, start, fail> OR <clone{test}, test, start, ok, pull, start>

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

var probe = pmx.probe();
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
  console.log('all items have been processed');
};

var defer = task => {
  queue.push(task);
  console.log('Running tasks', queue.length());
};

var app = express();
var handler = Hook({});

probe.metric({name: 'Port', value: ()=> conf.port});
probe.metric({name: 'Start', value: ()=> conf.start});
probe.metric({name: 'End', value: ()=> conf.end});

function exec(p, cb) {
  console.info(p);

  if (cb === true) {
    return shell.exec(p);
  }

  var out = '';
  var child = shell.exec(p, {async: true, silent: true});
  child.stdout.on('data', data => {
    console.log(data);
    out += data;
  });

  child.stderr.on('data', data => {
    console.error(data);
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
      fs.writeFileSync(ecofile, JSON.stringify(system, null, 4), {encoding: 'utf8'});
    } catch (e) {
      // ignore
    }
  }
}

function resolve(uri, branch, opts) {
  opts = extend(true, {scale: null, test: false}, opts);

  var mode = opts.test ? 'test' : '';
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

function trigger(ctx, event, cb) {
  var runScript = ['cd ', ctx.dir, '&&', '.', './branchoff@' + event].join(' ');
  exec(runScript, cb);
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
  var name = ctx.port + '-' + ctx.branch;

  var system = ecosystem();
  delete system[ctx.id];
  ecosystem(system);

  var removeDir = ["rm -rf", ctx.dir].join(" ");
  exec(removeDir, ()=>0);

  pm2.connect(function (err) {
    if (err) {
      console.error(err);
      return cb(err);
    }
    pm2.delete(name, err => {
      if (err) {
        console.error(err);
        return cb(err);
      }
      cb();
    });
  });
}

function start(ctx, cb) {
  console.log('Starting ' + ctx.id);

  var config = {};

  try {
    config = JSON.parse(fs.readFileSync(ctx.dir + `/branchoff@config`, {encoding: 'utf8'}))
  } catch (e) {
    console.error("Reverting to default config", e);
  }

  pm2.connect(function (err) {
    if (err) return cb(err);

    console.log('PM2 connected');

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

    console.log(config);

    pm2.delete(name, () => {
      console.log('PM2 delete');
      pm2.start(config, err => {
        if (err) {
          console.error(err);
          return cb(err);
        }
        pm2.disconnect();
        if (err) {
          console.error(err);
          return cb(err);
        }
        console.log("Started process: " + name);
        cb();
      });
    });
  });
}

var Reducer = {
  restore(then, opts) {
    var system = ecosystem();
    for (var m in system) {
      (function (ctx) {
        opts = opts || {};
        ctx = resolve(ctx.uri, ctx.branch, {test: false});

        console.tag('jumpstart').log(ctx, opts);

        defer(cb => create(ctx, cb));
        defer(cb => trigger(ctx, 'create', cb));
        defer(cb => start(ctx, cb));
        defer(then);
      })(system[m])
    }
  },
  create: function (uri, branch, then, opts) {
    opts = opts || {};

    var ctx = resolve(uri, branch, {test: true}); // resolve test dir

    console.tag('create').log(ctx, opts);

    defer(cb=> create(ctx, cb)); // clone test
    defer(cb=> trigger(ctx, 'create', cb)); // run create script
    defer(cb => start(ctx, cb)); // start test
    defer(cb=> trigger(ctx, 'test', (code, output)=> { // trigger test script
      console.log({code: code, output: output});

      // trigger script with args
      console.log(trigger(ctx, code ? 'fail' : 'ok', true, JSON.stringify({code: code, output: output})));

      defer(cb => destroy(ctx, cb)); // destroy the test repo
      cb();

      // if test is ok
      if (!code) {
        ctx = resolve(uri, branch, {test: false}); // resolve actual directory
        defer(cb=> create(ctx, cb)); // clone
        defer(cb=> trigger(ctx, 'create', cb)); // run create script
        defer(cb => start(ctx, cb)); // start
      }

      defer(then);
    }));
  },
  update: function (uri, branch, then, opts) {
    opts = opts || {};

    var ctx = resolve(uri, branch, {test: true, scale: opts.scale}); // resolve test dir

    console.tag('update').log(ctx, opts);

    defer(cb=> create(ctx, cb)); // clone test
    defer(cb=> trigger(ctx, 'create', cb)); // run create script
    defer(cb => start(ctx, cb)); // start test
    defer(cb=> trigger(ctx, 'test', (code, output)=> { // trigger test script
      console.log({code: code, output: output});

      // trigger script with args
      console.log(trigger(ctx, code ? 'fail' : 'ok', true, JSON.stringify({code: code, output: output})));

      // destroy the test repo
      defer(cb => destroy(ctx, cb));
      cb();

      // if test is ok
      if (!code) {
        // resolve actual directory
        ctx = resolve(uri, branch, {test: false, scale: opts.scale});
        defer(cb=> create(ctx, cb)); // clone
        defer(cb=> update(ctx, true, cb)); // update
        defer(cb=> trigger(ctx, 'push', cb)); // run create script
        defer(cb => start(ctx, cb)); // start
      }

      defer(then);
    }));
  },
  destroy: function (uri, branch, then, opts) {
    var ctx = resolve(uri, branch, {test: false});

    console.tag('destroy').log(ctx, opts);

    defer(cb=> trigger(ctx, 'delete', cb));
    defer(cb => destroy(ctx, cb));
    defer(then);
  }
};

function handleGitEvent(event, payload) {
  var repository = payload.repository;
  var uri = repository.html_url;
  var branch = repository.default_branch;

  try {
    branch = payload.ref.substr(payload.ref.lastIndexOf('/') + 1);
  } catch (e) {
    // ignore
  }

  switch (event) {
    case "ping":
      throw Error('Ping event does not have enough information');
      break;
    case "create":
      if (payload.ref_type !== 'branch') {
        throw Error('Ignoring create request');
      }

      branch = payload.ref;
      break;
    case "push":
      if (payload.created == true) {
        event = "create";
      } else if (payload.deleted == true) {
        event = 'destroy';
        break;
      }
      break;
    case "pull_request":
      branch = payload.base.name;
      break;
  }

  if (!uri || !branch) {
    throw Error('Unable to resolve uri and branch');
  }

  console.log(event, uri, branch);

  switch (event) {
    case "create":
      return Reducer.create(uri, branch);
    case "push":
      return Reducer.update(uri, branch);
    case "destroy":
      return Reducer.destroy(uri, branch);
  }
}

Object.keys(events).forEach(e=> {
  if (e != '*') {
    handler.on(e, e => handleGitEvent(e.event, e.payload));
  }
});

handler.on('error', err=> console.error('Error:', err.message));

app.use(console.middleware('express'));
app.use('/scribe', console.viewer());
app.get('/test', (req, res)=> res.send({ok: true}));
app.post('/github/postreceive', handler);
app.set('view engine', 'jade');
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
app.get('/', (req, res)=> res.render('index'));
app.post('/ecosystem', (req, res)=> res.json(ecosystem()));
app.get('/ecosystem', (req, res)=> res.render('ecosystem', {ecosystem: ecosystem()}));
app.get('/destroy', (req, res)=> res.redirect('/'));
app.get('/deploy', (req, res)=> res.redirect('/'));

app.post('/destroy', (req, res)=> {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);

  console.log(req.body);

  Reducer.destroy(uri, branch, ()=>res.redirect('/ecosystem'));
});

app.post('/deploy', (req, res)=> {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';
  var func;

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);
  func = req.body.update ? 'update' : 'create';

  console.log(req.body, func);

  Reducer[func](uri, branch, ()=>res.redirect('/ecosystem'), {scale: req.body.scale});
});


app.listen(conf.port, ()=> console.log('Listening to port ' + conf.port));

if (require.main === module) {
  Reducer.restore();
}