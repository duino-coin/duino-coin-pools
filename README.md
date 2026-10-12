<h1 align="center">Welcome to duino-pools 👋</h1>
<p align ="center">
    <img src="https://img.shields.io/badge/node-%3E%3D16.0.0-blue.svg?logo=node.js&logoColor=white" />
    <img alt="Maintenance" src="https://img.shields.io/badge/maintained-yes-green.svg" />
    <img alt="License: MIT" src="https://img.shields.io/github/license/Bilaboz/duino-stats" />
</p>

Duino Pools are mining nodes for Duino-Coin written in node.js.

  * [Duino-Coin Github page](https://github.com/revoxhere/duino-coin)
  * [Duino-Coin Website](https://duinocoin.com) 

## Docker

Set `poolName`, `poolPassword`, and `poolID` in `config/config.json`, then run:

```sh
docker compose up -d --build
```

The mining TCP port is 6000. The live dashboard from [PR #5](https://github.com/duino-coin/duino-coin-pools/pull/5) is available on port 6030. The host `config` directory keeps configuration, bans, and rewards between container replacements. The `sync-data` Docker volume keeps worker sync files and dashboard history. The image installs dependencies from `package.json` because the current `package-lock.json` does not contain all declared dependencies.

The Dockerfile supports `linux/amd64` (x64), `linux/arm64` (64-bit Raspberry Pi OS), and `linux/arm/v7` (32-bit Raspberry Pi OS). `docker compose up -d --build` builds for the current machine. To build one target on another machine with Buildx, for example ARMv7, run:

```sh
docker buildx build --platform linux/arm/v7 -t duino-coin-pool:armv7 --load .
```

To publish one image tag containing all three platforms, use a Buildx builder with emulation or native workers and run:

```sh
docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t YOUR_REGISTRY/duino-coin-pool:latest --push .
```

Replace `YOUR_REGISTRY` with a registry you can push to. Docker then selects the matching image on each host. The CI workflow builds all three platforms on pushes and pull requests without publishing an image.

## Show your support

Give a ⭐️ if this project helped you!

## 📝 License

Copyright © 2021-2022 [Bilaboz](https://github.com/Bilaboz) from the Duino-Coin team.<br />
Copyright © 2021-2022 [revox](https://piotrowsky.dev) from the Duino-Coin team.<br />
This project is [MIT](https://github.com/Bilaboz/duino-stats/blob/main/LICENSE) licensed.

***
