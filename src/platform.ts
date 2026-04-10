import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig as HomebridgePlatformConfig,
  Service,
} from "homebridge";
import {
  buildCloudHeaders,
  buildManualDeviceConfig,
  CLOUD_LOGIN_URL,
  CLOUD_THINGS_URL,
  findOverrideForThing,
  getAuthType,
  mergeCloudThingWithOverride,
  normalizeOptionalString,
  parseBrokerInfo,
  requestJson,
} from "./bluestar.js";
import { MqttSyncManager } from "./mqttSync.js";
import { deriveMacAddressFromThingId, findLanIpByMacAddress } from "./networkDiscovery.js";
import { BlueStarAcPlatformAccessory } from "./platformAccessory.js";
import { DEFAULT_PLATFORM_NAME, PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { SyncScheduler } from "./syncScheduler.js";
import type { AccessoryContext, BrokerInfo, CloudThing, DeviceConfig, PlatformConfig } from "./types.js";
import { UdpRegistry } from "./udpRegistry.js";

interface LoginPayload {
  session?: string;
  mi?: string;
}

interface ThingsPayload {
  things?: CloudThing[];
}

interface DiscoveryResult {
  devices: DeviceConfig[];
  sessionId?: string;
  brokerInfo?: BrokerInfo;
}

export class BlueStarAcPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory<AccessoryContext>> = new Map();
  public readonly deviceBindings = new Map<string, BlueStarAcPlatformAccessory>();
  public readonly discoveredCacheUUIDs: string[] = [];
  public readonly registry: UdpRegistry;
  public readonly config: PlatformConfig;

  private readonly authId: string;
  private readonly password: string;
  private readonly syncScheduler: SyncScheduler;
  private mqttSyncManager?: MqttSyncManager;
  private mqttConnectionKey?: string;

  constructor(
    public readonly log: Logger,
    config: HomebridgePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as PlatformConfig;
    this.registry = new UdpRegistry(log);
    this.authId = this.config.authId?.trim() ?? "";
    this.password = this.config.password ?? "";
    this.syncScheduler = new SyncScheduler(log, 5_000, (thingId) => {
      this.requestCloudSync(thingId, "periodic refresh");
    });

    this.log.debug("Finished initializing platform:", this.config.name ?? DEFAULT_PLATFORM_NAME);

    this.api.on("didFinishLaunching", () => {
      this.log.debug("Executed didFinishLaunching callback");
      void this.discoverDevices();
    });
    this.api.on("shutdown", () => {
      this.syncScheduler.stop();
      this.mqttSyncManager?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info("Loading accessory from cache:", accessory.displayName);
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  registerDeviceBinding(binding: BlueStarAcPlatformAccessory): void {
    this.deviceBindings.set(binding.thingId, binding);
  }

  unregisterDeviceBinding(thingId: string): void {
    this.deviceBindings.delete(thingId);
  }

  private mergeCachedDeviceState(device: DeviceConfig, cachedDevice?: DeviceConfig): DeviceConfig {
    const currentIp = normalizeOptionalString(device.ip);
    const cachedIp = cachedDevice?.thingId === device.thingId
      ? normalizeOptionalString(cachedDevice.ip)
      : undefined;

    if (!currentIp || currentIp === cachedIp) {
      return {
        ...device,
        ip: cachedIp ?? currentIp,
      };
    }

    return {
      ...device,
      ip: currentIp,
    };
  }

  async resolveDeviceIp(device: DeviceConfig): Promise<string | undefined> {
    const currentIp = normalizeOptionalString(device.ip);
    if (currentIp) {
      return currentIp;
    }

    const macAddress = deriveMacAddressFromThingId(device.thingId);
    if (!macAddress) {
      return undefined;
    }

    const discoveredIp = normalizeOptionalString(await findLanIpByMacAddress(macAddress));
    if (discoveredIp) {
      this.log.info(`${device.name}: resolved device IP ${discoveredIp} from LAN neighbour table (${macAddress})`);
    } else {
      this.log.debug(`${device.name}: no LAN neighbour entry found for ${macAddress}`);
    }

    return discoveredIp;
  }

  async discoverDevices(): Promise<void> {
    this.discoveredCacheUUIDs.length = 0;

    try {
      const discovery = await this.resolveDevices();
      const devices = discovery.devices;

      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.thingId}`);
        this.discoveredCacheUUIDs.push(uuid);
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
          const mergedDevice = this.mergeCachedDeviceState(device, existingAccessory.context.device);
          const resolvedDevice = {
            ...mergedDevice,
            ip: await this.resolveDeviceIp(mergedDevice) ?? mergedDevice.ip,
          };
          this.log.info("Restoring existing accessory from cache:", existingAccessory.displayName);
          existingAccessory.context.device = resolvedDevice;
          this.api.updatePlatformAccessories([existingAccessory]);
          new BlueStarAcPlatformAccessory(this, existingAccessory, resolvedDevice);
          continue;
        }

        const resolvedDevice = {
          ...device,
          ip: await this.resolveDeviceIp(device) ?? device.ip,
        };
        this.log.info("Adding new accessory:", device.name);
        const accessory = new this.api.platformAccessory<AccessoryContext>(resolvedDevice.name, uuid);
        accessory.context.device = resolvedDevice;
        new BlueStarAcPlatformAccessory(this, accessory, resolvedDevice);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      for (const [uuid, accessory] of this.accessories) {
        if (this.discoveredCacheUUIDs.includes(uuid)) {
          continue;
        }

        this.log.info("Removing existing accessory from cache:", accessory.displayName);
        this.unregisterDeviceBinding(accessory.context.device.thingId);
        this.registry.unregister(accessory.context.device.thingId);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }

      this.configureStateSync(discovery);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Device discovery failed: ${message}`);
    }
  }

  requestCloudSync(thingId: string, reason: string): void {
    this.mqttSyncManager?.forceSync(thingId, reason);
  }

  private handleMqttStateReport(thingId: string, packet: Record<string, unknown>): void {
    this.deviceBindings.get(thingId)?.handleMqttState(packet);
  }

  private handleMqttPresenceChange(thingId: string, isOnline: boolean, timestamp: number): void {
    this.deviceBindings.get(thingId)?.handlePresenceChange(isOnline, timestamp);
  }

  private configureStateSync(discovery: DiscoveryResult): void {
    if (!discovery.sessionId || !discovery.brokerInfo) {
      this.syncScheduler.stop();
      this.mqttSyncManager?.stop();
      this.mqttSyncManager = undefined;
      this.mqttConnectionKey = undefined;
      return;
    }

    const nextConnectionKey = `${discovery.sessionId}|${discovery.brokerInfo.endpoint}|${discovery.brokerInfo.accessKeyId}`;
    if (!this.mqttSyncManager || this.mqttConnectionKey !== nextConnectionKey) {
      this.mqttSyncManager?.stop();
      this.mqttSyncManager = new MqttSyncManager(this.log, discovery.brokerInfo, discovery.sessionId);
      this.mqttConnectionKey = nextConnectionKey;
    }

    this.mqttSyncManager.syncDevices(discovery.devices.map((device) => ({
      thingId: device.thingId,
      callbacks: {
        onStateReport: (packet) => this.handleMqttStateReport(device.thingId, packet),
        onPresenceChange: (isOnline, timestamp) => this.handleMqttPresenceChange(device.thingId, isOnline, timestamp),
      },
    })));
    this.syncScheduler.syncThingIds(discovery.devices.map((device) => device.thingId));
  }

  private async resolveDevices(): Promise<DiscoveryResult> {
    const overrides = this.config.devices ?? [];
    if (this.authId && this.password) {
      return this.resolveCloudDevices(overrides);
    }

    if (overrides.length === 0) {
      throw new Error("Configure cloud login or provide manual devices with thingId and uat");
    }

    return {
      devices: overrides.map((override) => buildManualDeviceConfig(override)),
    };
  }

  private async resolveCloudDevices(overrides: PlatformConfig["devices"] = []): Promise<DiscoveryResult> {
    const loginPayload = await requestJson<LoginPayload>(CLOUD_LOGIN_URL, {
      method: "POST",
      headers: buildCloudHeaders(),
      body: JSON.stringify({
        auth_id: this.authId,
        auth_type: getAuthType(this.authId),
        password: this.password,
      }),
    });

    if (!loginPayload.session) {
      throw new Error("Login response did not include session");
    }

    const brokerInfo = parseBrokerInfo(loginPayload.mi);
    if (!brokerInfo) {
      this.log.warn("Login response did not include broker info; MQTT state sync is disabled");
    }

    const thingsPayload = await requestJson<ThingsPayload>(CLOUD_THINGS_URL, {
      method: "GET",
      headers: buildCloudHeaders(loginPayload.session),
    });

    const allThings = Array.isArray(thingsPayload.things) ? thingsPayload.things : [];
    if (allThings.length === 0) {
      throw new Error("No Blue Star devices were returned for this account");
    }

    const selectedThingIds = new Set((this.config.selectedThingIds ?? []).map((value) => value.trim()));
    const selectedThings = allThings.filter((thing) => {
      const thingId = String(thing.thing_id ?? "");
      if (selectedThingIds.has(thingId)) {
        return true;
      }

      return Boolean(findOverrideForThing(thing, overrides));
    });

    if (selectedThings.length === 0) {
      throw new Error("No Blue Star ACs are selected. Open the plugin settings and choose at least one device.");
    }

    return {
      devices: selectedThings.map((thing) => {
        const override = findOverrideForThing(thing, overrides);
        return mergeCloudThingWithOverride(thing, override);
      }),
      sessionId: loginPayload.session,
      brokerInfo,
    };
  }
}
