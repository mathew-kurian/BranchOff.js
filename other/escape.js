var terminal = require('child_process').spawn('bash');
var esc = require('shell-escape');
var out = '';

var cmd = '. ./branchoff@pass ' + esc([0, 'invoked when branch is test\nWARNING: NODE_APP_INSTANCE value of \'0\' did not match any instance config file names.\nWARNING: See https://github.com/lorenwest/node-config/wiki/Strict-Mode\nScribe assuming you have mongo installed - false\\\!\\\!\\\!\nScribe assuming you socket port open - false\\\!\\\!\\\!\n   Client Created with From Number:  +15125200133 \n   Client Created with From Number:  +15005550006 \n   undefined \n    \n     TwilioSend \n       To \n\r         ✓ should give error code 21211 [Invalid \'To\' Phone Number] (606ms) \n\r         ✓ should give error code 21612 [The \'To\' phone number is not currently reachable via SMS or MMS] (355ms) \n\r         ✓ should give error 21408 [Permission to send an SMS has not been enabled for the region indicated by the \'To\' number] (390ms) \n\r         ✓ should give error 21610 [Message cannot be sent to the \'To\' number because the customer has replied with STOP] (377ms) \n\r         ✓ should give error 21614 [\'To\' number is not a valid mobile number] (350ms) \n\r         ✓ should be a valid number (354ms) \n       From \n\r         ✓ should give error code 21212 [Invalid \'From\' Phone Number] (403ms) \n\r         ✓ should give error 21602 [The \'From\' phone number provided is not a valid, message-capable Twilio phone number.] (395ms) \n\r         ✓ should give error 21611 [This \'From\' number has exceeded the maximum number of queued messages] (409ms) \n\r         ✓ should give no error (373ms) \n   undefined \n   undefined \n     10 passing (4s) \n   undefined \n"']);

setTimeout(function () {
  console.log('Sending stdin to terminal');
  terminal.stdin.write(cmd.replace(/\r/g, '') + '\n');
  console.log('Ending terminal session');
  terminal.stdin.end();
}, 1000);

terminal.stdout.on('data', data => {
  out += data.toString('utf8');
});

terminal.stderr.on('data', data => {
  out += data.toString('utf8');
});

terminal.on('exit', code => console.log(code, out));