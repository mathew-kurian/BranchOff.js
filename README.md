# BranchOff PM2 Module
**BETA ONLY**
In BranchOff, each branch gets its own port and is auto-deployed on change!
Benefits of auto-deployment for each Git branch in agile development:

 - Avoid multiple servers
 - Set up dependencies easily
 - Invokes scripts based on git actions 
 - Allows for shared database
 
### Requirements / Limitations
- Webhooks for Github only. Other services coming in the future

### Simple Dashboard
![](/screenshots/dashboard-0.png)
 
### Setup
```bash
$ pm2 install branch-off
```

### Options
```bash
pm2 conf branch-off:port 5000       # webhook port
pm2 conf branch-off:socketPort 5999 # socket port
pm2 conf branch-off:start 3000      # port range start
pm2 conf branch-off:end 4000        # port range end
pm2 conf branch-off:dir "~/cache"   # working directory
pm2 conf branch-off:maxInstances -1 # max instance count; <= 0 means auto

# default branch to start with
pm2 conf branch-off:default_branch https://github.com/bluejamesbond/BranchOff.js#master 
```

### Webhook
```
POST http://<host>:<port>/github/postreceive  # webhook
GET  http://<host>:<port>/                    # dashboard
POST http://<host>:<port>/ecosystem           # ecosystem
GET  http://<host>:<port>/ecosystem           # visual ecosystem

# deploy a uri, branch, scale; 
# e.g. http://localhost:4000/deploy?uri=https://github.com/bluejamesbond/BranchOff.js&branch=Yolocat&scale=1
POST  http://<host>:<port>/deploy?uri=<uri>&branch=<branch>&scale=<num> # deploy
POST  http://<host>:<port>/destory?uri=<uri>&branch=<branch>      # destroy        
```
