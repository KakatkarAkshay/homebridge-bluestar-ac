import dgram from "node:dgram";
import type { Logger } from "homebridge";
import {
  decryptLocalPacket,
  encryptForDeviceAppMode,
  encryptForDeviceStandardMode,
  extractJsonText,
  UDP_PORT,
} from "./bluestar.js";
import type { UdpAccessoryBinding } from "./types.js";

export class UdpRegistry {
  private readonly accessories = new Map<string, UdpAccessoryBinding>();
  private socket: dgram.Socket | null = null;

  constructor(private readonly log: Logger) {}

  register(accessory: UdpAccessoryBinding): void {
    this.ensureSocket();
    this.accessories.set(accessory.thingId, accessory);
  }

  unregister(thingId: string): void {
    this.accessories.delete(thingId);
  }

  send(accessory: UdpAccessoryBinding, payload: string): void {
    this.ensureSocket();
    if (!this.socket || !accessory.ipAddress) {
      throw new Error("Device IP is unknown");
    }

    const encoded = accessory.sendMode === "standard"
      ? encryptForDeviceStandardMode(payload, accessory.localKey)
      : encryptForDeviceAppMode(payload, accessory.localKey);
    const packet = Buffer.from(encoded, "ascii");

    for (let index = 0; index < 5; index += 1) {
      setTimeout(() => {
        this.socket?.send(packet, UDP_PORT, accessory.ipAddress);
      }, index * 100);
    }
  }

  private ensureSocket(): void {
    if (this.socket) {
      return;
    }

    this.socket = dgram.createSocket("udp4");
    this.socket.on("error", (error) => {
      this.log.warn(`UDP socket error: ${error.message}`);
    });
    this.socket.on("message", (message, remoteInfo) => {
      this.handleMessage(message, remoteInfo.address);
    });
    this.socket.bind(UDP_PORT, () => {
      this.log.info(`Listening for Blue Star AC UDP on ${UDP_PORT}`);
    });
  }

  private handleMessage(message: Buffer, sourceIp?: string): void {
    const text = message.toString("ascii").trim();
    if (!text.startsWith("(") || !text.endsWith(")") || !text.includes("|")) {
      return;
    }

    const packetText = text.slice(1, -1);
    const separatorIndex = packetText.indexOf("|");
    const thingId = packetText.slice(0, separatorIndex);
    const encoded = packetText.slice(separatorIndex + 1);
    const accessory = this.accessories.get(thingId);
    if (!accessory) {
      return;
    }

    try {
      const decrypted = decryptLocalPacket(encoded, accessory.localKey);
      const packet = JSON.parse(extractJsonText(decrypted)) as Record<string, unknown>;
      accessory.handleLocalState(packet, sourceIp);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.log.debug(`Failed to decode local UDP packet for ${thingId}: ${messageText}`);
    }
  }
}
