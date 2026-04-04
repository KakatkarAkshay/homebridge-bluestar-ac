import crypto from "node:crypto";
import dgram from "node:dgram";

const UDP_PORT = 44542;
const SOURCE_VALUE = "anlan";

function parseJsonArg(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function decryptLocalPacket(encoded, key) {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length <= 16) {
    throw new Error("UDP payload too short");
  }

  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("ascii").replace(/\0+$/g, "").trim();
}

function encryptForDeviceAppMode(text, key) {
  const iv = crypto.randomBytes(16);
  const body = Buffer.concat([iv, Buffer.from(text, "ascii")]);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return ciphertext.toString("base64");
}

function extractJsonText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in packet");
  }

  return text.slice(start, end + 1);
}

function matchesExpected(state, expected) {
  return Object.entries(expected).every(([key, value]) => {
    const actual = state[key];
    if (typeof value === "number") {
      return Number(actual) === value;
    }
    if (typeof value === "string") {
      return String(actual) === value;
    }
    return JSON.stringify(actual) === JSON.stringify(value);
  });
}

async function main() {
  const [, , ip, thingId, uat, deltaRaw, expectedRaw] = process.argv;
  if (!ip || !thingId || !uat || !deltaRaw) {
    throw new Error(
      "Usage: node udp-roundtrip.js <ip> <thingId> <uat> '<delta-json>' ['<expected-json>']",
    );
  }

  const delta = parseJsonArg(deltaRaw, "delta JSON");
  const expected = expectedRaw ? parseJsonArg(expectedRaw, "expected JSON") : delta;
  const key = Buffer.from(uat.slice(0, 16), "ascii");

  const payload = JSON.stringify({
    type: 1,
    uat,
    state: {
      desired: {
        ...delta,
        src: SOURCE_VALUE,
        ts: Date.now(),
      },
    },
  });

  const encoded = encryptForDeviceAppMode(payload, key);
  const packet = Buffer.from(encoded, "ascii");
  const socket = dgram.createSocket("udp4");

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timeout;
    const sendTimers = [];

    function cleanup() {
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      for (const timer of sendTimers) {
        clearTimeout(timer);
      }
      socket.removeAllListeners("message");
      socket.removeAllListeners("error");
      try {
        socket.close();
      } catch {
        // ignore
      }
    }

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for matching UDP state update"));
    }, 8000);

    socket.on("error", (error) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(error);
    });

    socket.on("message", (message, remoteInfo) => {
      try {
        const text = message.toString("ascii").trim();
        if (!text.startsWith("(") || !text.endsWith(")") || !text.includes("|")) {
          return;
        }

        const raw = text.slice(1, -1);
        const separatorIndex = raw.indexOf("|");
        const packetThingId = raw.slice(0, separatorIndex);
        if (packetThingId !== thingId) {
          return;
        }

        const encodedState = raw.slice(separatorIndex + 1);
        const decrypted = decryptLocalPacket(encodedState, key);
        const json = JSON.parse(extractJsonText(decrypted));

        if (matchesExpected(json, expected)) {
          cleanup();
          resolve({
            remoteInfo,
            state: json,
          });
        }
      } catch {
        // ignore unrelated packets
      }
    });

    socket.bind(UDP_PORT, () => {
      for (let i = 0; i < 5; i += 1) {
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          socket.send(packet, UDP_PORT, ip);
        }, i * 100);
        sendTimers.push(timer);
      }
    });
  });

  process.stdout.write(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
