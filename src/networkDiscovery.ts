import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOOKUP_COMMANDS: Array<{ command: string; args: string[] }> = [
  { command: "ip", args: ["neigh"] },
  { command: "arp", args: ["-an"] },
  { command: "arp", args: ["-a"] },
];

const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const MAC_PATTERN = /\b(?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}\b/i;

function normalizeMacGroups(groups: string[]): string | undefined {
  if (groups.length !== 6 || groups.some((group) => !/^[0-9a-f]{1,2}$/i.test(group))) {
    return undefined;
  }

  return groups.map((group) => group.toLowerCase().padStart(2, "0")).join(":");
}

export function normalizeMacAddress(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const splitGroups = normalizeMacGroups(value.split(/[:-]/).filter(Boolean));
  if (splitGroups) {
    return splitGroups;
  }

  const compact = value.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (compact.length !== 12) {
    return undefined;
  }

  const groups = compact.match(/.{1,2}/g);
  return groups ? groups.join(":") : undefined;
}

export function deriveMacAddressFromThingId(thingId: string): string | undefined {
  return normalizeMacAddress(thingId);
}

function extractIpMacPairs(text: string): Array<{ ip: string; mac: string }> {
  const pairs: Array<{ ip: string; mac: string }> = [];

  for (const line of text.split(/\r?\n/)) {
    const ip = line.match(IPV4_PATTERN)?.[0];
    const mac = normalizeMacAddress(line.match(MAC_PATTERN)?.[0]);
    if (ip && mac) {
      pairs.push({ ip, mac });
    }
  }

  return pairs;
}

export async function findLanIpByMacAddress(macAddress: string): Promise<string | undefined> {
  const targetMac = normalizeMacAddress(macAddress);
  if (!targetMac) {
    return undefined;
  }

  for (const lookup of LOOKUP_COMMANDS) {
    try {
      const { stdout } = await execFileAsync(lookup.command, lookup.args);
      const match = extractIpMacPairs(stdout).find((entry) => entry.mac === targetMac);
      if (match) {
        return match.ip;
      }
    } catch {
      // Ignore unavailable commands and keep trying the next lookup source.
    }
  }

  return undefined;
}
