/* Duino-Coin Mining handler
For documention about these functions see
https://github.com/revoxhere/duino-coin/blob/useful-tools
2019-2024 Duino-Coin community */

const crypto = require("crypto");
const request = require('sync-request');
const kolka = require("./kolka");
const log = require("./logging");
const {
    poolName,
    maxWorkers,
    blockReward,
    initialBlockHash,
    updateMinersStatsEvery,
    serverVersion,
    max_shares_per_minute,
} = require("../config/config.json");
const poolRewards = require("../config/poolRewards.json");
const pc_diff_tiers = ["EXTREME", "NET", "MEDIUM", "LOW"];
const algo = "DUCO-S1";


let lastBlockhash = initialBlockHash;
globalBlocks = [];
let workers = {};
let usrWorkers = {};
let minersStats = {};
let cachedItems = {};
let balancesToUpdate = {};
let globalShares = {
    increase: 0,
    total: 0,
};
if (!max_shares_per_minute) {
    let max_shares_per_minute = 80;
}

const getDiff = (poolRewards, textDiff) => {
    try {
        let { difficulty } = poolRewards[textDiff];
        return difficulty;
    } catch (err) {
        console.log(err);
    }
};

const checkWorkers = (ipWorkers, usrWorkers, serverMiners, username) => {
    if (maxWorkers <= 0) return false;

    if (Math.max(ipWorkers, usrWorkers, serverMiners) > maxWorkers) {
        return true;
        
    }
    return false;
};

// Read one message from the socket, with safe framing.
//
// The previous implementation attached a one-shot 'data' listener and
// resolved with whatever single chunk Node.js happened to deliver.
// TCP does not preserve application-level message boundaries: under
// event-loop pressure a single client message can span two 'data'
// events, or two messages can arrive in one event. The one-shot
// pattern had no way to recover — answer[0] ended up as fragments of
// a different message, parseInt returned NaN, miner_res !== random,
// and a valid share was rejected as "BAD,Incorrect result".
//
// This version installs a single persistent 'data' listener per
// connection, appends every chunk to a per-conn buffer, and hands
// pending promises one message at a time.
//
// Framing is dual-mode for backward compatibility with legacy miners
// (including the reference AVR_Miner.py / PC_Miner.py which do not
// append '\n' to their outgoing messages):
//
//   1. If the buffer contains '\n', cut the message there. This is
//      the robust path; new clients that send '\n' get it.
//   2. Otherwise wait LEGACY_IDLE_FLUSH_MS ms from the last chunk.
//      If no more bytes have arrived, treat the buffer as a single
//      message (legacy framing). Fragments of a single logical
//      message arrive sub-ms apart at receive side, so this idle
//      window cleanly distinguishes "still arriving" from "message
//      complete".
const LEGACY_IDLE_FLUSH_MS = 10;

const drain = (conn) => {
    while (conn._recvPending.length > 0) {
        const idx = conn._recvBuf.indexOf("\n");
        if (idx >= 0) {
            const line = conn._recvBuf.slice(0, idx);
            conn._recvBuf = conn._recvBuf.slice(idx + 1);
            conn._recvPending.shift()(line.trim());
            continue;
        }
        break;
    }
};

const legacyFlush = (conn) => {
    conn._flushTimer = null;
    if (conn._recvPending.length === 0) return;
    if (conn._recvBuf.length === 0) return;
    if (conn._recvBuf.indexOf("\n") >= 0) {
        drain(conn);
        return;
    }
    // No newline arrived within the idle window — assume a legacy
    // client that frames one message per 'data' event. Consume the
    // whole buffer as a single message.
    const line = conn._recvBuf;
    conn._recvBuf = "";
    conn._recvPending.shift()(line.trim());
};

const installRecvReader = (conn) => {
    if (conn._recvPending !== undefined) return;
    // conn._recvBuf may already contain leftover bytes placed there by
    // the initial data handler in connectionHandler.js — preserve them.
    if (conn._recvBuf === undefined) conn._recvBuf = "";
    conn._recvPending = [];
    conn._flushTimer = null;
    conn.on("data", (chunk) => {
        conn._recvBuf += chunk;
        drain(conn);
        // Re-arm the legacy idle flush on every new chunk. If more
        // fragments of the same message are still in flight, this
        // timer gets reset before it fires.
        if (conn._flushTimer) clearTimeout(conn._flushTimer);
        if (conn._recvPending.length > 0 && conn._recvBuf.length > 0) {
            conn._flushTimer = setTimeout(() => legacyFlush(conn),
                                          LEGACY_IDLE_FLUSH_MS);
        }
    });
};

const receiveData = (conn) => {
    installRecvReader(conn);
    return new Promise((resolve) => {
        // Fast path: a complete line (or any pre-buffered bytes) is
        // already waiting and no other receiver is ahead of us.
        if (conn._recvPending.length === 0) {
            const idx = conn._recvBuf.indexOf("\n");
            if (idx >= 0) {
                const line = conn._recvBuf.slice(0, idx);
                conn._recvBuf = conn._recvBuf.slice(idx + 1);
                resolve(line.trim());
                return;
            }
        }
        conn._recvPending.push(resolve);
        // If bytes are already pre-buffered without '\n' (possible
        // after mainListener leftover hand-off), arm the legacy idle
        // flush so we don't hang waiting for a '\n' that a legacy
        // client will never send.
        if (conn._recvBuf.length > 0 && !conn._flushTimer) {
            conn._flushTimer = setTimeout(() => legacyFlush(conn),
                                          LEGACY_IDLE_FLUSH_MS);
        }
    });
};

const getRand = (max) => {
    try {
        return crypto.randomInt(max);
    } catch (err) {
        console.log(err);
        return Math.floor(Math.random() * max);
    }
};

const percDiff = (a, b) => {
    return Math.floor(100 * Math.abs((a - b) / ((a + b) / 2)));
};

const avg_from_array = (array) => {
    const sum = array.reduce((acc, curr) => acc + curr, 0); 
    const average = sum / array.length; 
    return average; 
};

const miningHandler = async (conn, data, mainListener, usingAVR) => {
    let random, newHash, reqDifficulty, miningKey;
    let this_miner_chipid, minerName, sharetime;
    let feedback_sent = 0;
    let start_hashrate = -1;
    let diff = 1;
    let expectedSharetime, reportedHashrate; 
    let hashrate_calc, reward;
    let hashrateIsEstimated, hashrate, maxHashrate, minHashrate;
    let blockProbability, kolka_drop;

    let isFirstShare = true;
    conn.acceptedShares = 0;
    conn.rejectedShares = 0;

    const username = data[1];
    conn.username = username;
    conn.serverMiners = 0;
    conn.this_miner_id = 0;
    conn.lastminshares = 0;
    conn.lastsharereset = Math.floor(new Date() / 1000);
    conn.ping = 0;
    conn.sharetimes_list = []

    // remove the main listener to not re-trigger miningHandler()
    conn.removeListener("data", mainListener);
    while (true) {
        conn.reject_shares = false;
        conn.donate = false;

        if (isFirstShare) {
            reqDifficulty = data[2] ? data[2] : "NET";
            if (!poolRewards.hasOwnProperty(reqDifficulty)) reqDifficulty = "NET";
            diff = getDiff(poolRewards, reqDifficulty);

            if (reqDifficulty == "ESP32") worker_add = 0.5;
            else worker_add = 1;

            if (workers[conn.remoteAddress]) {
                workers[conn.remoteAddress] += worker_add;
            } else {
                workers[conn.remoteAddress] = worker_add;
            }

            if (usrWorkers[conn.username]) {
                usrWorkers[conn.username] += worker_add;
            } else {
                usrWorkers[conn.username] = worker_add;
            }

            if (conn.remoteAddress != "127.0.0.1") {
                conn.this_miner_id = Math.max(
                    usrWorkers[conn.username],
                    workers[conn.remoteAddress],
                    conn.serverMiners
                );
            } else {
                conn.this_miner_id = Math.max(
                    usrWorkers[conn.username],
                    conn.serverMiners
                );
            }
            conn.setTimeout(90 * 1000);
        } else {
            data = await receiveData(conn);
            data = data.split(",");
            conn.ping = (new Date() - feedback_sent) / 1000;

            if (conn.overrideDifficulty)
                reqDifficulty = conn.overrideDifficulty;
            else if (usingAVR) reqDifficulty = "AVR";
        }

        if (data[3]) miningKey = Buffer.from(data[3]).toString("base64");
        else miningKey = null;

        if (data[4]) {
            if (!data[4].match(/[A-Za-z0-9 .():@-]+/))
                conn.iot_reading = "Error:incorrect data";
            else if (data[4].length > 48)
                conn.iot_reading = "Error:data too long";
            else conn.iot_reading = data[4];
        } else conn.iot_reading = null;

        if (conn.remoteAddress != "127.0.0.1") {
            if (await checkWorkers(
                    workers[conn.remoteAddress],
                    usrWorkers[conn.username],
                    conn.serverMiners,
                    conn.username
                )
            ) {
                conn.reject_shares = "Too many workers";
            }
        } else {
            if (await checkWorkers(
                    0,
                    usrWorkers[conn.username],
                    conn.serverMiners,
                    conn.username
                )
            ) {
                conn.reject_shares = "Too many workers";
            }
        }

        if (conn.this_miner_id >
            Math.max(workers[conn.remoteAddress],
                    usrWorkers[conn.username],
                    conn.serverMiners)) {
            conn.this_miner_id = Math.max(
                workers[conn.remoteAddress],
                usrWorkers[conn.username],
                conn.serverMiners
            );
        }

        random = getRand(diff * 100) + 1;

        const shasum = crypto.createHash("sha1");
        shasum.update(lastBlockhash + random);
        newHash = shasum.digest("hex");
        let job = [lastBlockhash, newHash.toString(), diff];

        conn.write(job.toString() + "\n");
        let job_sent = new Date();
        let answer = await receiveData(conn);
        let answer_received = new Date();
        answer = answer.split(",");

        sharetime = (answer_received - job_sent) / 1000;
        if (sharetime > conn.ping) {
            sharetime -= conn.ping;
        }

        // 1.5x to account that the average will be half the target
        conn.sharetimes_list.push(sharetime*1.5);
        if (conn.sharetimes_list.length > 50) {
            // Memory leak prevention
            conn.sharetimes_list.shift();
        }

        reportedHashrate = parseFloat(answer[1]);
        if (reportedHashrate <= 0) {
            conn.reject_shares = "Invalid data";
        }

        if (sharetime >= 0.5) {
            hashrate_calc = random / sharetime;
        } else {
            hashrate_calc = reportedHashrate;
        }

        conn.lastminshares++;

        if (usingAVR) {
            miner_res = parseInt(answer[0], 2);
        } else {
            miner_res = parseInt(answer[0]);
        }

        /* try {
            if (diff <= getDiff(poolRewards, "ESP8266NH")) {
                const r = /[+-]?([0-9][.][0-9])+/;
                if (
                    parseFloat(answer[2].match(r)) &&
                    parseFloat(answer[2].match(r)[0]) <
                        parseFloat(serverVersion)
                ) {
                    conn.reject_shares = "Outdated miner";
                }
            }
        } catch (err) {
            conn.reject_shares = "No miner name";
        } */

        if (conn.lastminshares > max_shares_per_minute) {
            conn.reject_shares = "Too low difficulty";
        }

        hashrateIsEstimated = false;
        hashrate = hashrate_calc;
        if (!reportedHashrate) hashrateIsEstimated = true;
        else hashrate = reportedHashrate;

        if (isFirstShare) this_miner_chipid = answer[4];

        if (diff > getDiff(poolRewards, "DUE") &&
            diff <= getDiff(poolRewards, "ESP8266NH") &&
            percDiff(hashrate, hashrate_calc) > 15 &&
            sharetime >= 1.5
        ) {
            conn.reject_shares = "Modified hashrate";
        }

        if (
            (conn.acceptedShares == 4 || (conn.acceptedShares > 4 && percDiff(hashrate, start_hashrate) > 15))
            && pc_diff_tiers.includes(reqDifficulty)
            ) {
            start_hashrate = hashrate;
            diff = kolka.V3(avg_from_array(conn.sharetimes_list), expectedSharetime, diff, hashrate);
        }

        reward_div = poolRewards[reqDifficulty]["reward"];
        maxHashrate = poolRewards[reqDifficulty]["max_hashrate"];
        minHashrate = poolRewards[reqDifficulty]["min_hashrate"];
        expectedSharetime = poolRewards[reqDifficulty]["expected_sharetime"];
        blockProbability = poolRewards[reqDifficulty]["block_chance"];
        reward = 0;

        if (conn.reject_shares) {
            conn.write(`BAD,${conn.reject_shares}\n`);
            feedback_sent = new Date();
        } else if (hashrate < minHashrate) {
            conn.overrideDifficulty = kolka.V2_REVERSE(reqDifficulty);
            conn.rejectedShares++;
            conn.write("BAD,Too high starting difficulty\n");
            start_hashrate = -1;
            diff = getDiff(poolRewards, conn.overrideDifficulty);
            feedback_sent = new Date();
        } else if (hashrate >= maxHashrate) {
            conn.overrideDifficulty = kolka.V2(reqDifficulty);
            conn.rejectedShares++;
            conn.write("BAD,Too low starting difficulty\n");
            start_hashrate = -1;
            diff = getDiff(poolRewards, conn.overrideDifficulty);
            feedback_sent = new Date();
        } else if (miner_res === random) {
            conn.acceptedShares++;
            if (conn.acceptedShares > 10) {
                if (diff <= getDiff(poolRewards, "ESP8266NH")) {
                    if (!this_miner_chipid) {
                        conn.rejectedShares++;
                    } else if (answer[4] != this_miner_chipid) {
                        conn.rejectedShares++;
                    } else {
                        reward = kolka.V1(
                            hashrate_calc,
                            diff,
                            conn.this_miner_id,
                            reward_div
                        );
                    }
                } else {
                    reward = kolka.V1(
                        hashrate_calc,
                        diff,
                        conn.this_miner_id,
                        reward_div
                    );
                }
            }

            if (Math.floor(Math.random() * blockProbability) === 1) {
                reward += blockReward;

                const blockInfos = {
                    timestamp: Date.now(),
                    finder: conn.username,
                    amount: reward,
                    algo: "DUCO-S1",
                    hash: newHash.toString(),
                };

                globalBlocks.push(blockInfos);
                log.info(`Block found by ${conn.username}`);
                conn.write("BLOCK\n");
                feedback_sent = new Date();
            } else {
                conn.write("GOOD\n");
                feedback_sent = new Date();
            }
        } else {
            conn.rejectedShares++;
            conn.write("BAD,Incorrect result\n");
            feedback_sent = new Date();
        }

        if (
            conn.acceptedShares > 0 &&
            conn.acceptedShares % updateMinersStatsEvery === 0
        ) {
            if (balancesToUpdate[conn.username])
                balancesToUpdate[conn.username] += reward;
            else balancesToUpdate[conn.username] = reward;

            try {
                minerName = answer[2].match(/[A-Za-z0-9 .()-]+/g).join(" ");
            } catch (err) {
                miner_name = "Unknown miner";
            }

            let wallet_id;
            try {
                wallet_id = parseInt(answer[5]);
            } catch (err) {
                wallet_id = "None";
            }

            let rigIdentifier;
            try {
                const cut_rigid = answer[3].split(":");

                rigIdentifier = cut_rigid[0]
                    .match(/[A-Za-z0-9 .()-]+/g)
                    .join(" ");

                if (cut_rigid[1])
                    // mining key backwards compatibility for old miners
                    miningKey = Buffer.from(cut_rigid[1]).toString("base64");
            } catch (err) {
                rigIdentifier = "None";
            }

            if (Math.floor(new Date() / 1000) - conn.lastsharereset >= 60) {
                conn.lastsharereset = Math.floor(new Date() / 1000);
                conn.lastminshares = 0;
            }

            //if (conn.this_miner_id > 4) {
                kolka_drop = conn.this_miner_id;
            //} else {
            //    kolka_drop = 1;
            //}

            minersStats[conn.id] = {
                u: conn.username,
                h: hashrateIsEstimated ? hashrate : reportedHashrate,
                s: sharetime,
                a: conn.acceptedShares,
                r: conn.rejectedShares,
                c: kolka_drop,
                al: algo,
                d: diff,
                p: poolName,
                sft: minerName,
                id: rigIdentifier,
                t: Math.floor(new Date() / 1000),
                wd: wallet_id,
                k: this_miner_chipid,
                pw: miningKey,
                ls: conn.lastminshares,
                it: conn.iot_reading,
                ip: conn.remoteAddress,
                pg: conn.ping,
                rw: reward,
            };
            lastBlockhash = newHash;
            globalShares.increase += updateMinersStatsEvery;
            globalShares.total += updateMinersStatsEvery;
        }

        isFirstShare = false;
    }
};

module.exports = {
    miningHandler,
};

module.exports.stats = {
    workers,
    usrWorkers,
    minersStats,
    balancesToUpdate,
    globalShares,
    globalBlocks,
};
