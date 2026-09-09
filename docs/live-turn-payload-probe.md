# Bounded TURN payload probe (MDS-08/09)

Source audit `2ce5e2c`: the live infrastructure gate proves authenticated TURN
candidate gathering, but creates no counterpart and cannot prove selected-pair
or payload transport. Keep the newly bounded, secret-free supervisor and the
existing OIDC/session/ephemeral-credential checks.

Replace each candidate-only probe with two owned native peer connections,
both forced to relay. Exchange a fresh fixed-size synthetic data-channel probe
and exact echo, then require current selected relay pairs and connected
DTLS/SCTP on both sides. Do not accept nomination or candidate gathering alone.
The browser sub-operation has its own fixed deadline and always closes its
owned channels/connections. No real media, room payload, capture, identities,
keys, SDP or ICE values are returned.

The report must explicitly label this as same-browser synthetic data-channel
transport: not an independent external receiver, application SFrame/media
delivery, a machine-dialog acceptance or production release evidence. Preserve
failed/absent credential behavior and the whole-process deadline.

Use injectable peer/deadline seams for deterministic refusal, timeout, echo,
stats and cleanup tests. Then run the exact browser function against the
existing private authenticated TURN fixture, separately from the current
long Ananta soak. No public deployment, trust or operator-account change is
authorized by this test implementation.
