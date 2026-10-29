# Rollback

The plugin changes no host configuration, no Pi Pocket core file, and no system service. Rollback is therefore local and reversible.

## 1. Turn the plugin off

In Pi Pocket: **Menu → Extensions → LayerFS → off**.

This removes the module's route, browser module, tools, and tickets. It closes the module's page. It does **not** stop the private service and does **not** delete data.

## 2. Stop the service

In its terminal, press `Ctrl-C` or send `SIGTERM`. The service closes its socket/token clients and removes only its own socket. Do not delete the token or Store unless you intend to lose the project.

If you started the service from a script, stop that script. This project does not install a systemd unit.

## 3. Remove the drop-in copy

```bash
npm run uninstall:dropin -- --target /path/to/independent/dropin
```

The uninstaller reads `.layerfs-install.json` and removes only files whose SHA-256 still matches. It refuses a changed file. It never removes a Store, config, token, service, or Pi Pocket data.

If the target was a temporary independent copy, remove the copy by your normal means after the uninstaller.

### Remove a config created by the route

`POST /api/x/pocket-layerfs/config/delete` with `{ "expectedSha256": "<current hash>" }` removes only the own config file. It refuses a stale hash. It keeps the folder, a service, a Store, and every other file. Do not restore a whole core config over other work.

## 4. Keep or remove the runtime

Keep:

```text
.runtime/sdk
.runtime/layerfs-home
.runtime/store/<project>
.runtime/config.json
```

These are the pinned SDK, the LayerFS home, the Store, and your config. Removing them loses the project and its history; this project has no delete/restore command.

Remove only if you are sure:

```bash
# Destructive. This project does not run this for you.
rm -rf .runtime
```

## What cannot be rolled back

- A Branch created by `branch.fork` is a real LayerFS Branch. This project has no delete or merge operation. Removing it requires upstream tools or a reviewed manual plan; do not pretend a rollback deleted it.
- A Store is Disposable: no crash/power-loss recovery. Keep a stopped-service copy if the data matters.
- A preview ticket that was consumed cannot be reused. Make a new preview after a rollback/reload.

## Version rollback

This project pins LayerFS v1.0.0 and its archive SHA-256. Do not mix a v1.0.0 plugin with a newer SDK/native addon or a newer `main` build. To roll back this plugin, use a previous commit of this repository with the same `upstream.lock.json`; rebuild or re-verify the SDK with `npm run setup -- --check`.

The service refuses to start when the installed SDK and native addon do not match the reviewed content pin (`upstream.lock.json`) or a matching private receipt, or when `.runtime/sdk/UPSTREAM.json`, the SDK package version, or `upstream.lock.json` disagree. That refusal is the rollback guard; do not bypass it by editing the marker, which is not a trust root.
