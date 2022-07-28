# Uniswap V3 Subgraph

### Subgraph Endpoint 

Synced at: https://thegraph.com/hosted-service/subgraph/ianlapham/uniswap-v3-subgraph?selected=playground

Pending Changes at same URL

### Example of usage access token as a command line parameter
* `graph deploy --debug --ipfs https://api.thegraph.com/ipfs/ --node https://api.thegraph.com/deploy/ --access-token <YOUR KEY>`

### Commands for graph deploy
* `npm run codegen`
* `npm run build`
* `npm run deploy-cyberlight -- --access-token=<ACCESS TOKEN>`

NOTE: Standard command `graph auth --product hosted-servic https://api.thegraph.com/deploy/ <YOUR KEY>` not working with current version of `graph-cli` library, because of error `Error storing access token with libsecret`

```
graph auth --product hosted-servic https://api.thegraph.com/deploy/ <YOUR KEY>
Error: Error storing access token with libsecret (usually gnome-keyring or ksecretservice): Error: Cannot spawn a message bus without a machine-id: Unable to load /var/lib/dbus/machine-id or /etc/machine-id: Failed to open file “/var/lib/dbus/machine-id”: No such file or directory
    at saveAccessToken (/home/node/.config/yarn/global/node_modules/@graphprotocol/graph-cli/src/command-helpers/auth.js:70:13)
    at async Command.run (/home/node/.config/yarn/global/node_modules/@graphprotocol/graph-cli/src/commands/auth.js:61:7)
```