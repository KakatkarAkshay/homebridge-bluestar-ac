import { HomebridgePluginUiServer, RequestError } from "@homebridge/plugin-ui-utils";
import {
  buildCloudHeaders,
  CLOUD_LOGIN_URL,
  CLOUD_THINGS_URL,
  getAuthType,
  requestJson,
} from "../bluestar.js";
import type { CloudThing } from "../types.js";

interface DiscoveryRequest {
  authId?: string;
  password?: string;
}

interface LoginPayload {
  session?: string;
}

interface ThingsPayload {
  things?: CloudThing[];
}

class BlueStarUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest("/discover", this.handleDiscoverRequest.bind(this));
    this.ready();
  }

  private resolveCredentials(payload: DiscoveryRequest): { authId: string; password: string } {
    const authId = payload.authId?.trim() ?? "";
    const password = payload.password ?? "";

    if (!authId || !password) {
      throw new RequestError("Provide Blue Star credentials.", { status: 400 });
    }

    return { authId, password };
  }

  private async handleDiscoverRequest(payload: DiscoveryRequest): Promise<{ devices: Array<{ thingId: string; name: string }> }> {
    const { authId, password } = this.resolveCredentials(payload);

    try {
      const loginPayload = await requestJson<LoginPayload>(CLOUD_LOGIN_URL, {
        method: "POST",
        headers: buildCloudHeaders(),
        body: JSON.stringify({
          auth_id: authId,
          auth_type: getAuthType(authId),
          password,
        }),
      });

      if (!loginPayload.session) {
        throw new RequestError("Blue Star login succeeded but did not return a session.", { status: 502 });
      }

      const thingsPayload = await requestJson<ThingsPayload>(CLOUD_THINGS_URL, {
        method: "GET",
        headers: buildCloudHeaders(loginPayload.session),
      });

      const things = Array.isArray(thingsPayload.things) ? thingsPayload.things : [];
      const devices = things
        .map((thing) => ({
          thingId: String(thing.thing_id ?? ""),
          name: String(thing.user_config?.name ?? thing.thing_id ?? "").trim(),
        }))
        .filter((device) => device.thingId);

      return { devices };
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Blue Star discovery failed.";
      throw new RequestError(message, { status: 500 });
    }
  }
}

(() => new BlueStarUiServer())();
