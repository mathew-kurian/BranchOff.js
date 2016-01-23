#!/usr/bin/env node
'use strict';

var express = require('express');
var basicAuth = require('basic-auth');
var Hook = require('github-webhook-handler');
var events = require('github-webhook-handler/events');
var bodyParser = require('body-parser');
var core = require('./core');
var program = require('commander');
var pkg = require('./package.json');
var selectn = require('selectn');

var app = express();
var handler = Hook({});
var console = core.console;
var defer = core.defer;
var conf = core.conf;

// pipelines
// create: <clone{stage}, stage, fail> OR <clone{stage}, stage, ok, clone, run>
// update: <clone{stage}, stage, start, fail> OR <clone{stage}, stage, start, ok, pull, start>
var Pipeline = {
  restore: function restore(then, opts) {
    var self = this;

    opts = opts || {};

    var system = core.ecosystem();
    for (var id in system) {
      if (system.hasOwnProperty(id)) {
        (function (ctx, id) {
          console.tag('jumpstart', id).log(ctx, opts);

          if (ctx.mode === 'stage' || !core.accept(ctx.uri, ctx.branch)) {
            self.destroy(ctx.uri, ctx.branch, null, ctx);
          } else {
            defer(function (cb) {
              core.create(ctx, cb);
            }, 'restore#create');
            defer(function (cb) {
              core.trigger(ctx, 'create', cb);
            }, 'restore#trigger -> create');
            defer(function (cb) {
              core.start(ctx, cb);
            }, 'restore#start');
            defer(then, 'restore#callback');
          }
        })(system[id], id);
      }
    }
  },
  create: function create(uri, branch, then, opts) {
    opts = opts || {};

    this.stage(uri, branch, function (err) {
      if (err) {
        console.tag('update').log('stages failed! Skipping deployment');
      } else {
        var ctx = core.resolve(uri, branch, {scale: opts.scale});
        console.tag('update').log('stages passed! Deploying actual branch');

        defer(function (cb) {
          core.create(ctx, cb);
        }, 'create#create');
        defer(function (cb) {
          core.trigger(ctx, 'create', cb);
        }, 'create#trigger -> create');
        defer(function (cb) {
          core.start(ctx, cb);
        }, 'create#start');
      }

      defer(then, 'create#callback');
    }, opts);
  },
  stage: function stage(uri, branch, then, opts) {
    opts = opts || {};

    var retcode, retout;
    var ctx = core.resolve(uri, branch, {mode: 'stage', scale: opts.scale});

    console.tag('stage').log(ctx, opts);

    defer(function (cb) {
      core.create(ctx, cb, opts.commit);
    }, 'stage#create');
    defer(function (cb) {
      core.trigger(ctx, 'create', cb, [ctx.mode]);
    }, 'stage#trigger -> create');
    defer(function (cb) {
      core.start(ctx, cb);
    }, 'stage#start');
    defer(function (cb) {
      core.trigger(ctx, 'test', function (code, output) {
        console.tag('stage').log({code: code, output: output});
        console.tag('stage').log(core.trigger(ctx, code ? 'fail' : 'pass', true, [code, output]));

        retcode = code;
        retout = output;

        cb();
      }, [ctx.mode]);
    }, 'stage#trigger -> stage');

    // delete after
    console.tag('destroy').log(ctx);

    defer(function (cb) {
      core.trigger(ctx, 'destroy', cb);
    }, 'destroy#trigger -> destroy');
    defer(function (cb) {
      core.destroy(ctx, cb);
    }, 'destroy#destroy');

    // postpone
    defer(function () {
      return then(retcode, retout);
    }, 'stage#callback');
  },
  update: function update(uri, branch, then, opts) {
    opts = opts || {};

    this.stage(uri, branch, function (err) {
      if (err) {
        console.tag('update').log('Staging failed! Skipping deployment');
      } else {
        var ctx = core.resolve(uri, branch, {scale: opts.scale, commit: opts.commit});

        console.tag('update').log('Staging passed! Deploying actual branch');

        defer(function (cb) {
          core.create(ctx, cb);
        }, 'update#create');
        defer(function (cb) {
          core.update(ctx, cb);
        }, 'update#update');
        defer(function (cb) {
          core.trigger(ctx, 'update', cb);
        }, 'update#trigger -> update');
        defer(function (cb) {
          core.start(ctx, cb);
        }, 'update#start');
      }
    }, opts);

    defer(then, 'update#callback');
  },
  destroy: function destroy(uri, branch, then, opts) {
    opts = opts || {};

    var ctx = core.resolve(uri, branch, {mode: opts.mode});

    console.tag('destroy').log(ctx);

    defer(function (cb) {
      core.trigger(ctx, 'destroy', cb);
    }, 'destroy#trigger -> destroy');
    defer(function (cb) {
      core.destroy(ctx, cb);
    }, 'destroy#destroy');
    defer(then, 'destroy#callback');
  }
};

function handleGitEvent(event, payload) {
  var repository = payload.repository;
  var uri = repository.html_url;
  var commit;
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
    case "push":
      if (payload.created == true) {
        event = "create";
        commit = payload.after;
      } else if (payload.deleted == true) {
        event = 'destroy';
        break;
      } else {
        event = 'update';
        commit = payload.after;
      }
      break;
  }

  if (!uri || !branch) {
    throw Error('Unable to resolve uri and branch');
  }

  if (!core.accept(uri, branch)) {
    return console.tag('postreceive').log('Ignoring event - not part of acceptable uris, branches');
  }

  console.tag('postreceive').log(event, uri, branch);

  switch (event) {
    case "create":
      return Pipeline.create(uri, branch, null, {commit: commit});
    case "update":
      return Pipeline.update(uri, branch, null, {commit: commit});
    case "destroy":
      return Pipeline.destroy(uri, branch, null, {commit: commit});
  }
}

Object.keys(events).forEach(function (e) {
  if (e != '*') {
    handler.on(e, function (e) {
      return handleGitEvent(e.event, e.payload);
    });
  }
});

handler.on('error', function (err) {
  return console.error('Error:', err.message);
});

app.use(console.middleware('express'));

app.post('/github/postreceive', handler);

var authenticate = function (req, res, next) {
  function unauthorized(res) {
    res.set('WWW-Authenticate', 'Basic realm=Authorization Required');
    return res.sendStatus(401);
  }

  if (!conf.user && !conf.pass) {
    return next();
  }

  var user = basicAuth(req);

  if (!user || !user.name || !user.pass) {
    return unauthorized(res);
  }

  if (user.name === conf.user && user.pass === conf.pass) {
    return next();
  } else {
    return unauthorized(res);
  }
};

app.use(authenticate);
app.use('/scribe', console.viewer());

app.get('/test', function (req, res) {
  return res.send({ok: true});
});

app.set('view engine', 'jade');
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

app.get('/', function (req, res) {
  return res.render('index');
});

app.post('/ecosystem', function (req, res) {
  return res.json(core.ecosystem());
});

app.get('/ecosystem', function (req, res) {
  return res.render('ecosystem', {ecosystem: core.ecosystem()});
});

app.get('/destroy', function (req, res) {
  return res.redirect('/');
});

app.get('/deploy', function (req, res) {
  return res.redirect('/');
});

app.post('/destroy', function (req, res) {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';
  var mode = req.body.mode;

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);

  console.tag('/destroy').log(req.body);

  Pipeline.destroy(uri, branch, null, {mode: mode});

  res.redirect('/ecosystem');
});

app.post('/deploy', function (req, res) {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';
  var mode = req.body.mode;
  var commit = req.body.commit || 'latest';
  var scale = Number(req.body.scale);
  var update = req.body.update;
  var func = update ? 'update' : 'create';

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  if (!core.accept(uri, branch)) {
    throw new Error('Ignoring event - not part of acceptable uris, branches')
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);

  console.tag('/deploy').log(req.body);

  Pipeline[func](uri, branch, null, {scale: scale, mode: mode, commit: commit});

  res.redirect('/ecosystem');
});

function resolveLocal(mode) {
  var uri = core.exec('git config --get remote.origin.url').output.trim();
  var branch = core.exec('git rev-parse --abbrev-ref HEAD').output.trim();

  if (!uri && !branch) {
    throw new Error('Not a valid git repo?', uri, branch);
  }

  var dir = process.cwd();
  var ctx = core.resolve(uri, branch);

  // NOTE override cwd
  ctx.dir = dir;
  ctx.mode = mode || ctx.mode || 'manual';

  core.save(ctx);

  return ctx;
}

var noop = function () {
};

if (require.main === module && process.env.pmx_module) {
  app.listen(conf.port, function () {
    return console.tag('app').log('Listening to port ' + conf.port);
  });
  Pipeline.restore();
} else {
  // handle arguments
  program.version(pkg.version)
         .option('-p, --pipeline <n>', 'Use pipeline')
         .option('-s, --start <n>', 'Start port', parseInt, 3000)
         .option('-e, --end <n>', 'End port', parseInt, 4000);


  program.command('trigger <event> [mode]').action(function (event, mode) {
    var ctx = resolveLocal();
    var config = core.configuration(ctx);
    var script = config.main || config.start || selectn('pm2.script', config);

    var terminal = core.trigger(ctx, event, noop, [mode || ctx.mode], {log: false, stdio: ['pipe', 1, 2]});

    if (!terminal) {
      return process.exit(1);
    }

    terminal && terminal.on('exit', function (code) {
      console.tag('manual-trigger').log('Exit code', code).then(function () {
        return process.exit(code);
      });
    });
  });

  program.command('start [mode]').action(function (mode) {
    var ctx = resolveLocal(mode);
    var config = core.configuration(ctx);
    var script = config.main || config.start || selectn('pm2.script', config);

    if (!script) {
      throw new Error('Main script is not defined in branchoff@config');
    }

    console.tag('manual-start').log(core.env(ctx, 'start'));

    var terminal = core.exec(['cd', ctx.dir, '&&', script].join(' '), noop,
                             {cwd: ctx.dir, env: core.env(ctx, 'start'), log: false, stdio: ['pipe', 1, 2]});

    terminal.on('exit', function (code) {
      console.tag('manual-start').log('Exit code', code).then(function () {
        return process.exit(code);
      });
    });
  });

  program.parse(process.argv);
}