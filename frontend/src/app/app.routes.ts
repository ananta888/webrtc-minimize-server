import { Routes } from "@angular/router";

import { OidcCallbackComponent } from "./auth/oidc-callback.component";
import { RoomPageComponent } from "./features/room/room-page.component";

export const routes: Routes = [
  { path: "machine", loadComponent: () => import("./features/machine/machine-page.component").then(module => module.MachinePageComponent) },
  { path: "oidc-callback", component: OidcCallbackComponent },
  { path: "", component: RoomPageComponent },
  { path: "**", redirectTo: "" },
];
