import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig as HomebridgePlatformConfig,
  Service,
} from "homebridge";
import { DEFAULT_PLATFORM_NAME } from "./settings.js";

export class BlueStarAcPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  constructor(
    public readonly log: Logger,
    public readonly config: HomebridgePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.log.debug("Finished initializing platform:", this.config.name ?? DEFAULT_PLATFORM_NAME);
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info("Loading accessory from cache:", accessory.displayName);
  }
}
