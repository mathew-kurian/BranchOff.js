# BranchOff PM2 Module
In BranchOff, each branch gets its own port and is auto-deployed on change!
Benefits of auto-deployment for each Git branch in agile development:

 - Avoid multiple servers
 - Set up dependencies easily
 - Invokes scripts based on git actions 
 - Allows for shared database
 
### Requirements / Limitations
- Supports only Github for now

### Simple Dashboard
![](http://imgur.com/ff3IH0r.png)
 
### Setup
```bash
$ pm2 install git://github.com/bluejamesbond/BranchOff.js.git
```

### Options
```bash
pm2 conf branch-off:port 5000       # webhook port
pm2 conf branch-off:start 3000      # port range start
pm2 conf branch-off:end 4000        # port range end
pm2 conf branch-off:dir "~/cache"   # working directory

# default branch to start with
pm2 conf branch-off:default_branch https://github.com/bluejamesbond/BranchOff.js#master 
```

### Webhook
```
POST http://<host>:<port>/github/postreceive  # webhook
POST http://<host>:<port>/                    # running ecosystem
GET  http://<host>:<port>/                    # visual ecosystem

# deploy a uri, branch; 
# e.g. http://localhost:4000/deploy?uri=https://github.com/bluejamesbond/BranchOff.js&branch=Yolocat
POST  http://<host>:<port>/deploy?uri=<uri>&branch=<branch>       # deploy
POST  http://<host>:<port>/destory?uri=<uri>&branch=<branch>      # destroy        
```
