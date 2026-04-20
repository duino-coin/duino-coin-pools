/* Duino-Coin Connection handler
For documention about these functions see
https://github.com/revoxhere/duino-coin/blob/useful-tools
2019-2024 Duino-Coin community */

const fs = require("fs");
const crypto = require("crypto");
const log = require("./logging");
const mining = require("./mining");
const { exec } = require("child_process");
const bans = require("../config/bans.json");
const { motd, serverVersion } = require("../config/config.json");

if (bans.bannedIPs.length > 10) {
    bans.bannedIPs = [];
    fs.writeFileSync(
        "./config/bans.json",
        JSON.stringify(bans, null, 0)
    );
    log.info(`Cleared bans`);
}

const ban_ip = (ip) => {
    // uncomment the correct command for your firewall
    //const cmd = `csf -td ${ip}`; //csf
    //const cmd = `iptables -A INPUT -s ${ip} -j DROP`; //iptables
    //const cmd = `sudo ufw deny from ${ip} to any`; //ufw
    const cmd = '' //none

    if (cmd) {
        exec(cmd, (error) => {
            if (error) {
                log.warning(`Error banning ${ip}: ${error}`);
                return;
            } else {
                log.warning(`Banned ${ip}`);
            }
        });
    }
};

const handle = (conn) => {
    conn.id = crypto.randomBytes(8).toString("hex");
    try {
        conn.setTimeout(30 * 1000);
        conn.setEncoding("ascii");
        conn.write(serverVersion + "\n");
    } catch (err) {
        return conn.destroy();
    }

    conn.on("close", () => {
        try {
            delete mining.stats.minersStats[conn.id];
        } catch (err) {}
        try {
            mining.stats.workers[conn.remoteAddress] -= 1;
            if (mining.stats.workers[conn.remoteAddress] <= 0)
                delete mining.stats.workers[conn.remoteAddress];
        } catch (err) {}
        try {
            mining.stats.usrWorkers[conn.username] -= 1;
            if (mining.stats.usrWorkers[conn.username] <= 0)
                delete mining.stats.usrWorkers[conn.username];
        } catch (err) {}
    });

    conn.on("error", (err) => {
        if (err.code !== "ECONNRESET") {}
    });

    conn.on("timeout", () => {
        conn.destroy();
    });

    // mainListener accumulates incoming bytes until either a '\n'
    // terminator is seen OR a short idle gap suggests a legacy client
    // finished sending. TCP does not preserve application-level
    // boundaries, so handling the first chunk as if it were a full
    // message risked passing a truncated JOB request (e.g. data[3]
    // cut mid-mining_key) to miningHandler. Any bytes that followed
    // the first '\n' are fed into conn._recvBuf so miningHandler's
    // receiveData picks them up as the next message without loss.
    //
    // Dual-mode framing matches the same logic in mining.js's
    // receiveData: prefer '\n', fall back to "no data for 10 ms" for
    // legacy clients that don't terminate their messages.
    const MAIN_IDLE_FLUSH_MS = 10;
    let mainFlushTimer = null;

    // processParsedData contains the original mainListener body (the
    // ban / JOB / MOTD dispatch) unchanged. It is called exactly once
    // per client, with a cleanly-framed message.
    const processParsedData = (data) => {

        if (!conn.remoteAddress || data.length > 6) {
            conn.write("BAD,Incorrect data\n");
            return conn.destroy();
        }

        /* IP ban check */
        if (
            bans.bannedIPs.includes(conn.remoteAddress) &&
            conn.remoteAddress != "127.0.0.1"
        ) {
            conn.write("BAD,User banned\n");
            ban_ip(conn.remoteAddress);
            return conn.destroy();
        }

        /* Username ban check */
        if (
            bans.bannedUsernames.includes(data[1]) &&
            conn.remoteAddress != "127.0.0.1" &&
            !bans.bannedIPs.includes(conn.remoteAddress)
        ) {
            bans.bannedIPs.push(conn.remoteAddress);
            try {
                fs.writeFileSync(
                    "./config/bans.json",
                    JSON.stringify(bans, null, 0)
                );
            } catch (err) {
                console.log(err);
            }
            conn.write("BAD,User banned\n");
            ban_ip(conn.remoteAddress);
            return conn.destroy();
        }

        if (data[0] === "JOB") {
            if (!data[1]) {
                conn.write("BAD,No username specified\n");
                return conn.destroy();
            } else {
                if (!conn.username) conn.username = data[1];
                else if (conn.username != data[1]) {
                    return conn.destroy();
                }
                mining.miningHandler(conn, data, mainListener, false);
            }
        } else if (data[0] === "MOTD") {
            conn.write(motd);
        }
    };

    const dispatchMain = () => {
        if (mainFlushTimer) {
            clearTimeout(mainFlushTimer);
            mainFlushTimer = null;
        }
        const idx = (conn._mainBuf || "").indexOf("\n");
        if (idx >= 0) {
            const line = conn._mainBuf.slice(0, idx);
            const leftover = conn._mainBuf.slice(idx + 1);
            conn._mainBuf = "";
            if (leftover.length > 0) {
                conn._recvBuf = (conn._recvBuf || "") + leftover;
            }
            processParsedData(line.trim().split(","));
            return;
        }
        // No '\n' yet but no more data in flight: legacy client frame.
        if ((conn._mainBuf || "").length > 0) {
            const line = conn._mainBuf;
            conn._mainBuf = "";
            processParsedData(line.trim().split(","));
        }
    };

    const mainListener = (chunk) => {
        conn._mainBuf = (conn._mainBuf || "") + chunk;
        if (conn._mainBuf.indexOf("\n") >= 0) {
            dispatchMain();
            return;
        }
        if (mainFlushTimer) clearTimeout(mainFlushTimer);
        mainFlushTimer = setTimeout(dispatchMain, MAIN_IDLE_FLUSH_MS);
    };

    conn.on("data", mainListener);
};

module.exports = handle;
