import { Routes } from "@angular/router";

import { OidcCallbackComponent } from "./auth/oidc-callback.component";
import { RoomPageComponent } from "./features/room/room-page.component";
import { MachinePageComponent } from "./features/machine/machine-page.component";

export const routes: Routes = [
  { path: "machine", component: MachinePageComponent },
  { path: "oidc-callback", component: OidcCallbackComponent },
  { path: "", component: RoomPageComponent },
  { path: "**", redirectTo: "" },
];
