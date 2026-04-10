import type {
  Characteristic,
  CharacteristicValue,
  Logger,
  PlatformAccessory,
  Service,
} from "homebridge";
import {
  applyOptimisticDelta,
  AUTO_FAN_SPEED,
  buildDesiredEnvelope,
  buildModePayload,
  fanSpeedToRotation,
  isSwingEnabled,
  makeLocalKey,
  MODE_AUTO,
  MODE_COOL,
  MODE_HEAT,
  parseIntSafe,
  rotationToFanSpeed,
  SWING_OFF_VALUE,
  SWING_ON_VALUE,
  toDeviceTemperatureString,
  toHomeKitTemperature,
} from "./bluestar.js";
import type { BlueStarAcPlatform } from "./platform.js";
import type { AccessoryContext, DeviceConfig, DeviceState, UdpAccessoryBinding } from "./types.js";

export class BlueStarAcPlatformAccessory implements UdpAccessoryBinding {
  readonly thingId: string;
  readonly localKey: Buffer;
  readonly sendMode: DeviceConfig["sendMode"];

  readonly log: Logger;
  private readonly hapService: typeof Service;
  private readonly hapCharacteristic: typeof Characteristic;

  private informationService!: Service;
  private heaterCoolerService!: Service;
  private device: DeviceConfig;
  private state: DeviceState;
  private lastHeaterCoolerTargetState: number;

  constructor(
    private readonly platform: BlueStarAcPlatform,
    private readonly accessory: PlatformAccessory<AccessoryContext>,
    device: DeviceConfig,
  ) {
    this.device = device;
    this.thingId = device.thingId;
    this.sendMode = device.sendMode;
    this.localKey = makeLocalKey(device.uat);
    this.log = platform.log;
    this.hapService = platform.Service;
    this.hapCharacteristic = platform.Characteristic;
    this.lastHeaterCoolerTargetState = this.hapCharacteristic.TargetHeaterCoolerState.COOL;
    this.state = {
      pow: 0,
      mode: MODE_COOL,
      stemp: "24.0",
      ctemp: "24.0",
      fspd: AUTO_FAN_SPEED,
      hswing: SWING_OFF_VALUE,
      vswing: SWING_OFF_VALUE,
      display: 1,
      displayunit: this.hapCharacteristic.TemperatureDisplayUnits.CELSIUS,
      turbo: 0,
      ai: 0,
      esave: 0,
      eco: 0,
      health: 0,
      m_buz: 0,
      ifeel: 0,
      climate: 0,
      s_clean: 0,
      df_clean: 0,
      lastSeenAt: 0,
      source: "unknown",
    };

    this.accessory.context.device = device;
    this.configureAccessory();
    this.platform.registry.register(this);
  }

  get ipAddress(): string | undefined {
    return this.device.ip;
  }

  private persistDevice(device: DeviceConfig): void {
    this.device = device;
    this.accessory.context.device = device;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private learnIpAddress(ipAddress: string, source: string): void {
    if (this.device.ip === ipAddress) {
      return;
    }

    this.persistDevice({ ...this.device, ip: ipAddress });
    this.log.info(`${this.device.name}: learned device IP from ${source}: ${ipAddress}`);
  }

  handleLocalState(packet: Record<string, unknown>, sourceIp?: string): void {
    if (!this.device.ip && sourceIp) {
      this.learnIpAddress(sourceIp, "UDP broadcast");
    }

    this.state = {
      ...this.state,
      ...packet,
      lastSeenAt: Date.now(),
      source: sourceIp ?? this.state.source,
    };
    this.updateCharacteristics();
  }

  private configureAccessory(): void {
    this.accessory.displayName = this.device.name;
    this.informationService = this.accessory.getService(this.hapService.AccessoryInformation)
      ?? this.accessory.addService(this.hapService.AccessoryInformation);
    this.informationService
      .setCharacteristic(this.hapCharacteristic.Manufacturer, "Blue Star")
      .setCharacteristic(this.hapCharacteristic.Model, "Smart AC (Local UDP)")
      .setCharacteristic(this.hapCharacteristic.SerialNumber, this.device.thingId);

    this.heaterCoolerService = this.accessory.getServiceById(this.hapService.HeaterCooler, "heater-cooler")
      ?? this.accessory.addService(this.hapService.HeaterCooler, this.device.name, "heater-cooler");
    this.heaterCoolerService
      .setCharacteristic(this.hapCharacteristic.Name, this.device.name)
      .setCharacteristic(this.hapCharacteristic.Active, this.hapCharacteristic.Active.INACTIVE)
      .setCharacteristic(this.hapCharacteristic.CurrentTemperature, 24)
      .setCharacteristic(this.hapCharacteristic.CoolingThresholdTemperature, 24)
      .setCharacteristic(this.hapCharacteristic.HeatingThresholdTemperature, 24)
      .setCharacteristic(this.hapCharacteristic.SwingMode, this.hapCharacteristic.SwingMode.SWING_DISABLED)
      .setCharacteristic(this.hapCharacteristic.RotationSpeed, 0);

    this.heaterCoolerService.getCharacteristic(this.hapCharacteristic.Active)
      .onSet(this.setActive.bind(this));
    this.heaterCoolerService.getCharacteristic(this.hapCharacteristic.TargetHeaterCoolerState)
      .setProps({ validValues: this.getValidTargetHeaterCoolerStates() })
      .onSet(this.setTargetState.bind(this));
    this.heaterCoolerService.getCharacteristic(this.hapCharacteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 0.5 })
      .onSet(this.setCoolingThresholdTemperature.bind(this));
    this.heaterCoolerService.getCharacteristic(this.hapCharacteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 0.5 })
      .onSet(this.setHeatingThresholdTemperature.bind(this));
    this.heaterCoolerService.getCharacteristic(this.hapCharacteristic.RotationSpeed)
      .onSet(this.setHeaterCoolerRotationSpeed.bind(this));
    this.heaterCoolerService.getCharacteristic(this.hapCharacteristic.SwingMode)
      .onSet(this.setHeaterCoolerSwingMode.bind(this));
    this.heaterCoolerService.getCharacteristic(this.hapCharacteristic.TemperatureDisplayUnits)
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    this.updateCharacteristics();
  }

  private getCurrentModeValue(): number {
    return parseIntSafe(this.state.mode, MODE_COOL);
  }

  private getCurrentTemperatureUnit(): number {
    return parseIntSafe(this.state.displayunit, this.hapCharacteristic.TemperatureDisplayUnits.CELSIUS);
  }

  private getCurrentTargetTemperature(): number {
    return toHomeKitTemperature(this.state.stemp, this.getCurrentTemperatureUnit());
  }

  private getValidTargetHeaterCoolerStates(): number[] {
    const validValues = [this.hapCharacteristic.TargetHeaterCoolerState.COOL];
    if (this.device.supportedModes.includes("heat")) {
      validValues.push(this.hapCharacteristic.TargetHeaterCoolerState.HEAT);
    }
    if (this.device.supportedModes.includes("auto")) {
      validValues.push(this.hapCharacteristic.TargetHeaterCoolerState.AUTO);
    }
    return validValues;
  }

  private updateCharacteristics(): void {
    const power = parseIntSafe(this.state.pow, 0);
    const mode = this.getCurrentModeValue();
    const temperatureUnit = this.getCurrentTemperatureUnit();
    const currentTemp = toHomeKitTemperature(this.state.ctemp, temperatureUnit);
    const targetTemp = this.getCurrentTargetTemperature();
    const rotationSpeed = fanSpeedToRotation(this.state.fspd);
    const swingMode = isSwingEnabled(this.state)
      ? this.hapCharacteristic.SwingMode.SWING_ENABLED
      : this.hapCharacteristic.SwingMode.SWING_DISABLED;

    if (mode === MODE_HEAT) {
      this.lastHeaterCoolerTargetState = this.hapCharacteristic.TargetHeaterCoolerState.HEAT;
    } else if (mode === MODE_AUTO && this.device.supportedModes.includes("auto")) {
      this.lastHeaterCoolerTargetState = this.hapCharacteristic.TargetHeaterCoolerState.AUTO;
    } else if (mode === MODE_COOL) {
      this.lastHeaterCoolerTargetState = this.hapCharacteristic.TargetHeaterCoolerState.COOL;
    }

    const heaterCoolerActive = power === 1 && [MODE_COOL, MODE_HEAT, MODE_AUTO].includes(mode)
      ? this.hapCharacteristic.Active.ACTIVE
      : this.hapCharacteristic.Active.INACTIVE;

    let currentHeaterCoolerState = this.hapCharacteristic.CurrentHeaterCoolerState.INACTIVE;
    if (heaterCoolerActive === this.hapCharacteristic.Active.ACTIVE) {
      if (mode === MODE_HEAT) {
        currentHeaterCoolerState = this.hapCharacteristic.CurrentHeaterCoolerState.HEATING;
      } else if (mode === MODE_AUTO) {
        currentHeaterCoolerState = this.hapCharacteristic.CurrentHeaterCoolerState.IDLE;
      } else {
        currentHeaterCoolerState = this.hapCharacteristic.CurrentHeaterCoolerState.COOLING;
      }
    }

    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.Active, heaterCoolerActive);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.CurrentHeaterCoolerState, currentHeaterCoolerState);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.TargetHeaterCoolerState, this.lastHeaterCoolerTargetState);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.CurrentTemperature, currentTemp);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.CoolingThresholdTemperature, targetTemp);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.HeatingThresholdTemperature, targetTemp);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.RotationSpeed, rotationSpeed);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.SwingMode, swingMode);
    this.heaterCoolerService.updateCharacteristic(this.hapCharacteristic.TemperatureDisplayUnits, temperatureUnit);
  }

  private async ensureIpAddress(): Promise<string> {
    if (this.device.ip) {
      return this.device.ip;
    }

    const discoveredIp = await this.platform.resolveDeviceIp(this.device);
    if (discoveredIp) {
      this.learnIpAddress(discoveredIp, "LAN neighbour table");
      return discoveredIp;
    }

    throw new Error("Device IP is unknown; configure it or wait for a UDP state packet");
  }

  private async sendDesiredState(delta: Record<string, unknown>): Promise<void> {
    await this.ensureIpAddress();
    if (!this.device.ip) {
      throw new Error("Device IP is unknown; configure it or wait for a UDP state packet");
    }

    const payload = buildDesiredEnvelope(this.device.uat, delta);
    this.platform.registry.send(this, payload);
    this.state = applyOptimisticDelta(this.state, delta);
    this.updateCharacteristics();
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    this.sendDesiredState({ pow: value === this.hapCharacteristic.Active.ACTIVE ? 1 : 0 });
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    let mode = MODE_COOL;
    if (value === this.hapCharacteristic.TargetHeaterCoolerState.HEAT) {
      mode = MODE_HEAT;
    } else if (value === this.hapCharacteristic.TargetHeaterCoolerState.AUTO) {
      mode = MODE_AUTO;
    }

    this.sendDesiredState(buildModePayload(mode, this.state));
  }

  private async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.sendDesiredState({
      stemp: toDeviceTemperatureString(Number(value), this.getCurrentTemperatureUnit()),
      pow: 1,
    });
  }

  private async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.sendDesiredState({
      stemp: toDeviceTemperatureString(Number(value), this.getCurrentTemperatureUnit()),
      pow: 1,
    });
  }

  private async setHeaterCoolerRotationSpeed(value: CharacteristicValue): Promise<void> {
    this.sendDesiredState({ fspd: rotationToFanSpeed(Number(value)), pow: 1 });
  }

  private async setHeaterCoolerSwingMode(value: CharacteristicValue): Promise<void> {
    const enabled = value === this.hapCharacteristic.SwingMode.SWING_ENABLED;
    this.sendDesiredState({
      hswing: enabled ? SWING_ON_VALUE : SWING_OFF_VALUE,
      vswing: enabled ? SWING_ON_VALUE : SWING_OFF_VALUE,
      pow: 1,
    });
  }

  private async setTemperatureDisplayUnits(value: CharacteristicValue): Promise<void> {
    this.sendDesiredState({ displayunit: parseIntSafe(value, 0) });
  }
}
