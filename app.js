#!/usr/bin/env node

var express = require('express');
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
// create: <clone{test}, test, fail> OR <clone{test}, test, ok, clone, run>
// update: <clone{test}, test, start, fail> OR <clone{test}, test, start, ok, pull, start>
var Pipeline = {
  restore: function (then, opts) {
    var self = this;

    opts = opts || {};

    var system = core.ecosystem();
    for (var id in system) {
      if (system.hasOwnProperty(id)) {
        (function (ctx, id) {
          console.tag('jumpstart', id).log(ctx, opts);

          if (ctx.mode === 'test') {
            self.destroy(ctx.uri, ctx.branch, null, ctx);
          } else {
            defer(cb=> core.create(ctx, cb), 'restore#create');
            defer(cb=> core.trigger(ctx, 'create', cb), 'restore#trigger -> create');
            defer(cb=> core.start(ctx, cb), 'restore#start');
            defer(then, 'restore#callback');
          }
        })(system[id], id);
      }
    }
  },
  create: function (uri, branch, then, opts) {
    opts = opts || {};

    this.test(uri, branch, err => {
      if (err) {
        console.tag('update').log('Tests failed! Skipping deployment');
      } else {
        var ctx = core.resolve(uri, branch, {scale: opts.scale});
        console.tag('update').log('Tests passed! Deploying actual branch');

        defer(cb=> core.create(ctx, cb), 'create#create');
        defer(cb=> core.trigger(ctx, 'create', cb), 'create#trigger -> create');
        defer(cb=> core.start(ctx, cb), 'create#start');
      }

      defer(then, 'create#callback');
    }, opts);
  },
  test: function (uri, branch, then, opts) {
    opts = opts || {};

    var ctx = core.resolve(uri, branch, {mode: 'test', scale: opts.scale});

    console.tag('test').log(ctx, opts);

    defer(cb=> core.create(ctx, cb), 'test#create');
    defer(cb=> core.trigger(ctx, 'create', cb, [ctx.mode]), 'test#trigger -> create');
    defer(cb=> core.start(ctx, cb), 'test#start');
    defer(cb=> core.trigger(ctx, 'test', (code, output)=> {
      console.tag('test').log({code: code, output: output});
      console.tag('test').log(core.trigger(ctx, code ? 'fail' : 'pass', true, [code, output]));

      this.destroy(ctx.uri, ctx.branch, null, ctx);
      cb();

      defer(() => then(code), 'test#callback');
    }), 'test#trigger -> test');
  },
  update: function (uri, branch, then, opts) {
    opts = opts || {};

    this.test(uri, branch, err => {
      if (err) {
        console.tag('update').log('Tests failed! Skipping deployment');
      } else {
        var ctx = core.resolve(uri, branch, {scale: opts.scale});

        console.tag('update').log('Tests passed! Deploying actual branch');

        defer(cb=> core.create(ctx, cb), 'update#create');
        defer(cb=> core.update(ctx, cb), 'update#update');
        defer(cb=> core.trigger(ctx, 'update', cb), 'update#trigger -> update');
        defer(cb=> core.start(ctx, cb), 'update#start');
      }

      defer(then, 'update#callback');
    }, opts);
  },
  destroy: function (uri, branch, then, opts) {
    opts = opts || {};

    var ctx = core.resolve(uri, branch, {mode: opts.mode});

    console.tag('destroy').log(ctx);

    defer(cb=> core.trigger(ctx, 'destroy', cb), 'destroy#trigger -> destroy');
    defer(cb=> core.destroy(ctx, cb), 'destroy#destroy');
    defer(then, 'destroy#callback');
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
      } else {
        event = 'update';
      }
      break;
  }

  if (!uri || !branch) {
    throw Error('Unable to resolve uri and branch');
  }

  console.tag('postreceive').log(event, uri, branch);

  switch (event) {
    case "create":
      return Pipeline.create(uri, branch);
    case "update":
      return Pipeline.update(uri, branch);
    case "destroy":
      return Pipeline.destroy(uri, branch);
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
app.post('/ecosystem', (req, res)=> res.json(core.ecosystem()));
app.get('/ecosystem', (req, res)=> res.render('ecosystem', {ecosystem: core.ecosystem()}));
app.get('/destroy', (req, res)=> res.redirect('/'));
app.get('/deploy', (req, res)=> res.redirect('/'));

app.post('/destroy', (req, res)=> {
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

app.post('/deploy', (req, res)=> {
  var uri = req.body.uri;
  var branch = req.body.branch || 'master';
  var mode = req.body.mode;
  var scale = req.body.scale;
  var update = req.body.update;
  var func = update ? 'update' : 'create';

  if (!uri || !branch) {
    throw new Error('Uri, branch not provided');
  }

  uri = decodeURI(uri);
  branch = decodeURIComponent(branch);

  console.tag('/deploy').log(req.body);

  Pipeline[func](uri, branch, null, {scale: scale, mode: mode});

  res.redirect('/ecosystem');
});

if (require.main === module && process.env.started_as_module == true) {
  app.listen(conf.port, ()=> console.tag('app').log('Listening to port ' + conf.port));
  Pipeline.restore();
} else {
  // handle arguments
  program
      .version(pkg.version)
      .option('-p, --pipeline <n>', 'Use pipeline')
      .option('-s, --start <n>', 'Start port', parseInt, 3000)
      .option('-e, --end <n>', 'End port', parseInt, 4000);

  program
      .command('ignite')
      .action(function () {
        var uri = core.exec('git config --get remote.origin.url').output.trim();
        var branch = core.exec('git rev-parse --abbrev-ref HEAD').output.trim();

        if (!uri && !branch) {
          throw new Error('Not a valid git repo?', uri, branch)
        }

        var dir = process.cwd();
        var ctx = core.resolve(uri, branch);

        // NOTE override cwd
        ctx.dir = dir;
        ctx.mode = 'serial';

        core.save(ctx);

        var config = core.configuration(ctx);
        var script = config.main || selectn('pm2.script', config);

        if (!script) {
          throw new Error('Main script is not defined in branchoff@config');
        }

        console.log(core.env(ctx, 'start'));

        var terminal = core.exec(['cd', dir, '&&', script].join(' '), ()=>0, {cwd: dir, env: core.env(ctx, 'start')});

        terminal.stdout.on('data', data=> {
          data = data.toString('utf8');
          process.stdout.write(data + '\n');
        });

        terminal.stderr.on('data', data=> {
          data = data.toString('utf8');
          process.stderr.write(data + '\n');
        });

        terminal.on('exit', code=> {
          console.tag('ignite').log('Exit code', code).then(() =>
              process.exit(code));
        });
      });

  program.parse(process.argv);
}

