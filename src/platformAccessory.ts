import type { PlatformAccessory } from "homebridge";
import type { BlueStarAcPlatform } from "./platform.js";

export class BlueStarAcPlatformAccessory {
  constructor(
    private readonly platform: BlueStarAcPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.platform.log.debug(`Created accessory shell for ${this.accessory.displayName}`);
  }
}
