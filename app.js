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

var probe = pmx.probe();
var queue = async.queue((task, callback)=> {
  task(callback);
}, 1);

var app = express();
var handler = Hook({});
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

probe.metric({name: 'Port', value: ()=> conf.port});
probe.metric({name: 'Start', value: ()=> conf.start});
probe.metric({name: 'End', value: ()=> conf.end});

function exec(p) {
  return shell.exec(p, {silent: false}).output.trim();
}

function defer(action) {
  queue.push(callback => {
    if (action.length) {
      action(callback);
    } else {
      action();
      callback();
    }
  });
}

function ecosystem(system) {
  var ecofile = path.join(__dirname, '/../ecosystem.json');
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

function resolve(uri, branch) {
  var system = ecosystem();
  var folder = (uri + branch).replace(/[^a-zA-Z0-9\-]/g, '');
  var id = folder;
  var start = conf.start;
  var end = conf.end;
  var port = start;

  if (system[id]) {
    return system[id]; // return the context
  }

  nextPort: for (var i = start; i < end; i++) {
    for (var m in system) {
      if (system.hasOwnProperty(m) && system[m].port === i) {
        continue nextPort;
      }
    }

    port = i;
    break;
  }

  var cwd = path.join(__dirname, '/../repos');
  var dir = path.join(cwd, folder);
  var context = {uri: uri, cwd: cwd, id: folder, folder: folder, dir: dir, branch: branch, port: port};

  system[id] = context;

  console.log(context);

  ecosystem(system);

  return context;
}

function trigger(ctx, event) {
  var execScript = ['cd ', ctx.dir, '&&', '.', 'branchoff@' + event].join(' ');
  return exec(execScript).split('\n');
}

function create(ctx) {
  var createDir = ["mkdir -p", ctx.cwd].join(" ");
  var clone = ["cd", ctx.cwd, "&& git config --global credential.helper store && git clone --branch=" + ctx.branch,
    ctx.uri, ctx.dir].join(" ");

  exec(createDir);

  console.log(clone);

  return /(exists)/.test(exec(clone));
}

function update(ctx) {
  var pull = ["cd", ctx.dir, "&& git config credential.helper store && git pull"].join(" ");

  exec(pull);
}

function destroy(ctx, cb) {
  var name = ctx.port + '-' + ctx.branch;

  var system = ecosystem();
  delete system[ctx.id];
  ecosystem(system);

  var removeDir = ["rm -rf", ctx.dir].join(" ");
  exec(removeDir);

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

    config = Object.assign({}, {
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

    pm2.delete(name, () => {
      pm2.start(config, err => {
        if (err) return console.error(err) || cb(err);
        pm2.disconnect();
        if (err) return console.error(err) || cb(err);
        console.log("Started process");
        cb();
      });
    });
  });
}

function jumpstart(ctx) {
  console.log('Jumpstart ' + ctx.id + '...');

  defer(() => create(ctx));
  defer(() => trigger(ctx, 'create'));
  defer(() => trigger(ctx, 'push'));
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

  console.log(uri, branch);

  var ctx = resolve(uri, branch);

  switch (event) {
    case "create":
      defer(()=> create(ctx));
    case "pull_request":
    case "push":
      defer(()=> update(ctx));
    default:
      defer(()=> trigger(ctx, event));
      defer(cb => start(ctx, cb));
      break;
    case "destroy":
      defer(()=> trigger(ctx, event));
      defer(cb => destroy(ctx, cb));
  }
}

Object.keys(events).forEach(e=> {
  if (e != '*') {
    handler.on(e, e => handleGitEvent(e.event, e.payload));
  }
});

handler.on('error', err=> console.error('Error:', err.message));

app.get('/test', (req, res)=> res.send({ok: true}));

app.post('/github/postreceive', handler);

app.set('view engine', 'jade');

app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json());

app.post('/', (req, res)=> res.json(ecosystem()));

app.get('/', (req, res)=>{
  res.render('index');
});

app.post('/destroy', (req, res)=> {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);

  var context = resolve(uri, branch);
  destroy(context, ()=> res.redirect('/'));
});

app.post('/deploy', (req, res)=> {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);

  var context = resolve(uri, branch);
  jumpstart(context);
  res.redirect('/');
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