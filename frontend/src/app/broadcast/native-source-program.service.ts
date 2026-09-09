import { Injectable, OnDestroy, computed, signal } from "@angular/core";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { RuntimeConfigService } from "../core/runtime-config.service";
import { DeviceIdentityService } from "../identity/device-identity.service";
import { PeerMeshService } from "../webrtc/peer-mesh.service";
import { RoomSessionService } from "../webrtc/room-session.service";
import { SignalingService } from "../webrtc/signaling.service";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { NativePackagerOnboardingService } from "./native-packager-onboarding.service";
import { NativeSourceProgramController, NativeSourceProgramView } from "./native-source-program-controller";

/** Root lifetime, but exact human room/session ownership; never owns source media. */
@Injectable({ providedIn: "root" })
export class NativeSourceProgramService implements OnDestroy {
  readonly view = signal<NativeSourceProgramView>({ phase: "idle", active: false, program: null, error: "" });
  readonly candidates = computed(() => this.packagers.eligible(this.room.roomId())
    .filter(p => (p.capability?.capabilityVersion === 2 || p.capability?.capabilityVersion === 3 && p.capability.sourceAudioControlVersion === 1)
      && p.capability?.sourcePrograms === true
      && Number.isSafeInteger(p.capability.maximumRenditions) && p.capability.maximumRenditions >= 1
      && p.capability.maximumRenditions <= 3));
  readonly requestProgram = computed(() => ["live", "degraded"].includes(this.view().phase) ? this.view().program : null);
  readonly controller: NativeSourceProgramController;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly auth: OidcAuthService, private readonly runtime: RuntimeConfigService,
    private readonly device: DeviceIdentityService, private readonly room: RoomSessionService,
    private readonly mesh: PeerMeshService, private readonly signaling: SignalingService,
    private readonly packagers: NativePackagerOnboardingService, private readonly control: BroadcastControlPlaneService) {
    this.controller = new NativeSourceProgramController({
      context: () => this.context(),
      eligible: (id, count) => this.candidates().some(p => p.id === id && p.capability!.maximumRenditions >= count),
      create: (request, abort) => {
        if (request.roomId !== this.room.roomId()) throw new Error("native_source_program_room_changed");
        return control.createProgram(request.roomId, request.title, request.visibility, abort);
      },
      prepare: (program, request, abort) => control.prepareNativeSourceStart(program, request.packagerId,
        request.requestedRenditions, request.allowHardwareAcceleration, "user-action", abort),
      observe: (programId, abort) => control.nativeHandoffControl(programId, abort),
      stop: async (program, assignment) => {
        // Revoke delivery immediately, and independently require real native stop ACK.
        let failed = false;
        try { await control.stopProgram(program.programId, AbortSignal.timeout(12000)); } catch { failed = true; }
        if (assignment) try { await control.stopNativeAssignment(assignment, AbortSignal.timeout(15000)); } catch { failed = true; }
        else try { await control.confirmNativeProgramStopped(program.programId, AbortSignal.timeout(15000)); } catch { failed = true; }
        if (failed) throw new Error("native_source_program_stop_unconfirmed");
      },
      changed: view => this.view.set(view),
    });
    this.timer = setInterval(() => this.controller.tick(), 250);
  }

  private context(): string | null {
    const claims = this.auth.claims(), fingerprint = this.device.fingerprint(), config = this.runtime.value();
    if (!config?.nativePackagers.publicationEnabled || !this.room.joined() || !this.room.roomCreator()
      || this.room.machineExpiresAt() || this.signaling.status() !== "connected"
      || this.mesh.ownPeerId() !== this.room.peerId() || this.mesh.membershipEpoch() < 1
      || typeof claims?.["iss"] !== "string" || !claims["iss"] || claims["iss"].length > 1024
      || typeof claims["sub"] !== "string" || !claims["sub"] || claims["sub"].length > 1024
      || /[\u0000-\u001f\u007f]/.test(claims["iss"] + claims["sub"])
      || typeof claims["exp"] !== "number" || !Number.isFinite(claims["exp"]) || claims["exp"] * 1000 <= Date.now()
      || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)) return null;
    return JSON.stringify([this.room.roomId(), this.room.peerId(), this.mesh.membershipEpoch(), fingerprint, claims["iss"], claims["sub"]]);
  }
  sceneContext(): { key: string; program: NonNullable<NativeSourceProgramView["program"]> } | null {
    const key = this.context(), program = this.requestProgram();
    return key && program ? { key, program } : null;
  }
  audioContext(): { key: string; program: NonNullable<NativeSourceProgramView["program"]> } | null {
    const context = this.sceneContext(), id = this.controller.controlledPackagerId();
    const capability = this.candidates().find(p => p.id === id)?.capability;
    return context && capability?.capabilityVersion === 3 && capability.sourceAudioControlVersion === 1
      ? { ...context, key: JSON.stringify([context.key, id]) } : null;
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.controller.destroy(); }
}
