import type { Logger } from "homebridge";
import { auth, io, iot, mqtt } from "aws-iot-device-sdk-v2";
import type { BrokerInfo } from "./types.js";

const MQTT_KEEPALIVE_SECONDS = 30;
const MQTT_PING_TIMEOUT_MS = 10_000;
const MQTT_PROTOCOL_TIMEOUT_MS = 10_000;
const MQTT_FORCE_SYNC_DELAY_AFTER_SPUSH_MS = 500;

interface DeviceSyncCallbacks {
  onStateReport(packet: Record<string, unknown>): void;
  onPresenceChange(isOnline: boolean, timestamp: number): void;
}

function getStateTopic(thingId: string): string {
  return `things/${thingId}/state/reported`;
}

function getPresenceTopic(thingId: string): string {
  return `$aws/events/presence/+/${thingId}`;
}

function getForceSyncTopic(thingId: string): string {
  return `things/${thingId}/control`;
}

function parsePresenceTopic(topic: string): { thingId: string; isOnline: boolean } | undefined {
  const match = topic.match(/^\$aws\/events\/presence\/([^/]+)\/(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    thingId: match[2],
    isOnline: match[1] !== "disconnected",
  };
}

function payloadToUtf8(payload: mqtt.Payload): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString("utf8");
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
  }

  return String(payload);
}

export class MqttSyncManager {
  private readonly devices = new Map<string, DeviceSyncCallbacks>();
  private readonly pendingForceSyncTimers = new Map<string, NodeJS.Timeout>();
  private readonly subscribedTopics = new Set<string>();
  private client?: mqtt.MqttClient;
  private connection?: mqtt.MqttClientConnection;
  private started = false;
  private connected = false;

  constructor(
    private readonly log: Logger,
    private readonly brokerInfo: BrokerInfo,
    private readonly sessionId: string,
  ) {}

  syncDevices(devices: Array<{ thingId: string; callbacks: DeviceSyncCallbacks }>): void {
    const nextThingIds = new Set(devices.map((device) => device.thingId));

    for (const [thingId] of this.devices) {
      if (!nextThingIds.has(thingId)) {
        this.devices.delete(thingId);
        this.clearPendingForceSync(thingId);
        void this.unsubscribeThing(thingId);
      }
    }

    for (const device of devices) {
      this.devices.set(device.thingId, device.callbacks);
    }

    if (this.devices.size === 0) {
      this.stop();
      return;
    }

    this.ensureStarted();
    void this.subscribeAll();
    this.forceSyncAll("initial sync");
  }

  forceSync(thingId: string, reason = "periodic sync"): void {
    if (!this.connection || !this.connected) {
      this.log.debug(`${thingId}: skipped ${reason} because MQTT is not connected`);
      return;
    }

    void this.connection.publish(getForceSyncTopic(thingId), JSON.stringify({ fpsh: 1 }), mqtt.QoS.AtMostOnce, false)
      .then(() => {
        this.log.debug(`${thingId}: requested MQTT force sync (${reason})`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(`${thingId}: force sync failed (${reason}): ${message}`);
      });
  }

  stop(): void {
    for (const thingId of this.pendingForceSyncTimers.keys()) {
      this.clearPendingForceSync(thingId);
    }

    this.subscribedTopics.clear();
    this.connected = false;

    if (this.connection) {
      this.connection.removeAllListeners();
      void this.connection.disconnect().catch(() => undefined);
      this.connection = undefined;
    }

    this.client = undefined;
    this.started = false;
  }

  private ensureStarted(): void {
    if (this.started) {
      return;
    }

    const builder = iot.AwsIotMqttConnectionConfigBuilder.new_with_websockets({
      region: this.brokerInfo.region,
      credentials_provider: auth.AwsCredentialsProvider.newStatic(
        this.brokerInfo.accessKeyId,
        this.brokerInfo.secretAccessKey,
        this.brokerInfo.sessionToken,
      ),
    });
    builder.with_endpoint(this.brokerInfo.endpoint);
    builder.with_client_id(`u-${this.sessionId}`);
    builder.with_clean_session(true);
    builder.with_keep_alive_seconds(MQTT_KEEPALIVE_SECONDS);
    builder.with_ping_timeout_ms(MQTT_PING_TIMEOUT_MS);
    builder.with_protocol_operation_timeout_ms(MQTT_PROTOCOL_TIMEOUT_MS);

    this.client = new mqtt.MqttClient(new io.ClientBootstrap());
    this.connection = this.client.new_connection(builder.build());
    this.started = true;

    this.connection.on("connect", () => {
      this.connected = true;
      this.log.info("Connected to Blue Star MQTT broker");
    });
    this.connection.on("connection_success", () => {
      this.connected = true;
      void this.subscribeAll();
      this.forceSyncAll("broker connect");
    });
    this.connection.on("connection_failure", (event) => {
      this.connected = false;
      this.subscribedTopics.clear();
      const message = event.error?.error_name ?? String(event.error);
      this.log.warn(`Blue Star MQTT connection failed: ${message}`);
    });
    this.connection.on("interrupt", (error) => {
      this.connected = false;
      this.subscribedTopics.clear();
      this.log.warn(`Blue Star MQTT interrupted: ${error.message}`);
    });
    this.connection.on("resume", (returnCode, sessionPresent) => {
      this.connected = true;
      this.log.info(`Reconnected to Blue Star MQTT broker (returnCode=${returnCode}, sessionPresent=${sessionPresent})`);
      void this.subscribeAll();
      this.forceSyncAll("broker reconnect");
    });
    this.connection.on("error", (error) => {
      this.log.warn(`Blue Star MQTT error: ${error.message}`);
    });
    this.connection.on("closed", () => {
      this.connected = false;
      this.subscribedTopics.clear();
    });

    void this.connection.connect().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.connected = false;
      this.log.warn(`Blue Star MQTT initial connect failed: ${message}`);
    });
  }

  private async subscribeAll(): Promise<void> {
    if (!this.connection || !this.connected) {
      return;
    }

    for (const thingId of this.devices.keys()) {
      await this.subscribeTopic(getStateTopic(thingId), thingId);
      await this.subscribeTopic(getPresenceTopic(thingId), thingId);
    }
  }

  private async subscribeTopic(topic: string, thingId: string): Promise<void> {
    if (!this.connection || this.subscribedTopics.has(topic)) {
      return;
    }

    try {
      await this.connection.subscribe(topic, mqtt.QoS.AtLeastOnce, (incomingTopic, payload) => {
        try {
          this.handleMessage(incomingTopic, payload);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn(`Failed to process MQTT message on ${incomingTopic}: ${message}`);
        }
      });
      this.subscribedTopics.add(topic);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`${thingId}: MQTT subscribe failed for ${topic}: ${message}`);
    }
  }

  private async unsubscribeThing(thingId: string): Promise<void> {
    if (!this.connection) {
      return;
    }

    for (const topic of [getStateTopic(thingId), getPresenceTopic(thingId)]) {
      this.subscribedTopics.delete(topic);
      try {
        await this.connection.unsubscribe(topic);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(`${thingId}: MQTT unsubscribe failed for ${topic}: ${message}`);
      }
    }
  }

  private forceSyncAll(reason: string): void {
    for (const thingId of this.devices.keys()) {
      this.forceSync(thingId, reason);
    }
  }

  private clearPendingForceSync(thingId: string): void {
    const timer = this.pendingForceSyncTimers.get(thingId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.pendingForceSyncTimers.delete(thingId);
  }

  private scheduleFollowUpForceSync(thingId: string): void {
    this.clearPendingForceSync(thingId);
    const timer = setTimeout(() => {
      this.pendingForceSyncTimers.delete(thingId);
      this.forceSync(thingId, "follow-up sync after spush");
    }, MQTT_FORCE_SYNC_DELAY_AFTER_SPUSH_MS);
    this.pendingForceSyncTimers.set(thingId, timer);
  }

  private handleMessage(topic: string, payload: mqtt.Payload): void {
    const presence = parsePresenceTopic(topic);
    if (presence) {
      const message = this.parseJsonPayload(payload);
      const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
      this.devices.get(presence.thingId)?.onPresenceChange(presence.isOnline, timestamp);
      if (presence.isOnline) {
        this.forceSync(presence.thingId, "device presence online");
      }
      return;
    }

    const thingIdMatch = topic.match(/^things\/(.+)\/state\/reported$/);
    if (!thingIdMatch) {
      return;
    }

    const thingId = thingIdMatch[1];
    const message = this.parseJsonPayload(payload);
    const messageType = typeof message.type === "number" ? message.type : Number(message.type);
    if (Number.isFinite(messageType) && messageType !== 0) {
      return;
    }

    this.devices.get(thingId)?.onStateReport(message);
    if (String(message.src ?? "").toLowerCase() === "spush") {
      this.scheduleFollowUpForceSync(thingId);
    }
  }

  private parseJsonPayload(payload: mqtt.Payload): Record<string, unknown> {
    const text = payloadToUtf8(payload).trim();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  }
}
