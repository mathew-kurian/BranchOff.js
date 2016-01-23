var express = require('express');
var app = express();

console.log(process.env.BRANCHOFF_PORT);
console.log(process.env.BRANCHOFF_NAME);
console.log(process.env.BRANCHOFF_CWD);
console.log(process.env.NODE_ENV);

app.get('/', (req, res)=> {
  res.json({
    port: process.env.BRANCHOFF_PORT,
    name: process.env.BRANCHOFF_NAME,
    cwd: process.env.BRANCHOFF_CWD,
    env: process.env.NODE_ENV
  })
});

const server = app.listen(parseInt(process.env.BRANCHOFF_PORT) || 3000, ()=> {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Listening at http://%s:%s', host, port);
});