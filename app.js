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
  publicUri: 'http://localhost',
  basePath: 'scribe/',
  socketPort: conf.socketPort,
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
      port: 5000,
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
  if (task.length) {
    task(callback);
  } else {
    task();
    callback();
  }
}, 1);

var defer = queue.push.bind(queue);

var app = express();
var handler = Hook({});

probe.metric({name: 'Port', value: ()=> conf.port});
probe.metric({name: 'Start', value: ()=> conf.start});
probe.metric({name: 'End', value: ()=> conf.end});

function exec(p, cb) {
  console.info(p);

  return shell.exec(p, (code, stdout, stderr)=> {
    console.info(code);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    cb();
  });
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

function resolve(uri, branch, scale) {
  var system = ecosystem();
  var folder = (uri + branch).replace(/[^a-zA-Z0-9\-]/g, '');
  var id = folder;
  var start = conf.start;
  var end = conf.end;
  var port = start;
  var context;

  scale = Math.min(Math.abs(isNaN(parseInt(scale)) ? 1 : scale), os.cpus().length);

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

  context.scale = scale;

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
  var clone = ["cd", ctx.cwd, "&& git config --global credential.helper store && git clone --branch=" + ctx.branch,
    ctx.uri, ctx.dir].join(" ");

  exec([createDir, clone].join(' && '), cb);
}

function update(ctx, forced, cb) {
  var pull = ["cd", ctx.dir, "&& git config credential.helper store && git pull"].join(" ");

  if (forced) {
    pull += ' -f';
  }

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
    if (err) return console.error(err) || cb(err);
    pm2.delete(name, err => {
      if (err) return console.error(err) || cb(err);
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

    var name = ctx.port + '-' + ctx.branch;

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
      pm2.start(config, err => {
        if (err) return console.error(err) || cb(err);
        pm2.disconnect();
        if (err) return console.error(err) || cb(err);
        console.log("Started process: " + name);
        cb();
      });
    });
  });
}

function jumpstart(ctx, pull, req) {
  console.log('Jumpstart ' + ctx.id + ' - ' + pull);

  defer(cb => create(ctx, cb));
  defer(cb => trigger(ctx, 'create', cb));

  if (pull) {
    defer(cb => update(ctx, true, cb));
    defer(cb => trigger(ctx, 'push', cb));
  }

  defer(cb => start(ctx, cb));
}

function restore() {
  var system = ecosystem();
  for (var m in system) {
    jumpstart(system[m]);
  }
}

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

  var ctx = resolve(uri, branch);

  switch (event) {
    case "create":
      defer(cb=> create(ctx, cb));
    case "pull_request":
    case "push":
      defer(cb=> update(ctx, !!payload.forced, cb));
    default:
      defer(cb=> trigger(ctx, event, cb));
      defer(cb => start(ctx, cb));
      break;
    case "destroy":
      defer(cb=> trigger(ctx, event, cb));
      defer(cb => destroy(ctx, cb));
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

  var context = resolve(uri, branch);

  defer(cb => destroy(context, cb));
  defer(()=>res.redirect('/ecosystem'));
});

app.post('/deploy', (req, res)=> {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);

  var context = resolve(uri, branch, req.body.scale);

  console.log(context);

  jumpstart(context, req.body.update);

  defer(()=>res.redirect('/ecosystem'));
});

app.listen(conf.port, ()=> console.log('Listening to port ' + conf.port));

if (require.main === module) {
  restore();

  var branch, uri, repo = conf.default_repo;

  if (repo) {
    var idx = repo.indexOf("#");

    if (idx > -1) {
      uri = repo.substr(0, idx);
      branch = repo.substr(idx + 1);
    } else {
      uri = repo;
      branch = "master";
    }
  }

  if (uri && branch) {
    var context = resolve(uri, branch);
    jumpstart(context);
  }
}