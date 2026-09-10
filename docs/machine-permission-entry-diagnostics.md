# Ananta permission entry: bounded failure evidence

MDS-08, 10 September 2026. This is test instrumentation, not a production
diagnostic endpoint or a change to consent, capture, admission or retry policy.

CI `34457825256` on `f05a7ff` fails the Chromium authenticated TURN-TCP dialog
before the first source grant: the **Für diese KI einstellen** button does not
appear within the existing 30-second interaction budget. Its Firefox case passes.
The later `3226250` TURN job is also red; that run's main suite is still active.
Those observations do not establish a media, TLS, permission or Angular cause.

The private browser fixture now returns its already bounded startup observer.
Only on failure of that initial selection action, the dialog test reports those
fixed error categories and a separate read-only DOM projection:

- whether Analysis is the current view and the permission panel exists;
- the number of fixed-label KI selection buttons, capped at 20;
- whether the fixed empty-list notice is present;
- whether the fixed signaling-connected label is present.

No names, IDs, URLs, arbitrary DOM strings, tokens or media are returned. The
projection does not click, capture, fetch, rejoin, retry or change time limits.
An absent/failed page observation remains null rather than being called healthy.
Four focused tests pass (0.674 seconds), including missing/empty views, bounded
counts, unchanged DOM and private-content redaction. The targeted real Chromium
TURN-TCP case passes in 19.417 seconds: both endpoints report an actual TCP relay,
16,000 decoded PCM samples, correlated chat, own screen and three renewals. This
does not reproduce or explain the CI failure. The concurrently running isolated
Standby `npm run check` snapshot predates this test-only addition and is not
evidence for it. That main check already has a separate failed Chromium expiry
observation, so this focused pass is not a green project/release claim.

## First classified CI failure with the observer

The completed TURN job `102829112667` in run `34464294664` (`e7c2bac`) fails
the Chromium TCP permission-entry case after 32.585 s. Its closed report shows
a failed script request with `ERR_NETWORK_CHANGED`, console categories
`ERR_NETWORK_CHANGED` and `NG0750`, Analysis active, permission panel absent,
zero choices, no empty-list notice and signaling still connected. Firefox TCP
passes in 16.932 s with 16,000 PCM samples and increasing TCP-relay bytes at
both ends. The overall run's main suite was still active at this inspection.

This narrows this occurrence to a failed script/deferred-view load; it is not
an empty machine-membership list or this run's TLS-proxy-start failure. The
cause of the network-change event remains unknown. No timeout, automatic
retry, resource preloading or production logic was changed on this evidence.
This result does not prove the cause of the older uninstrumented failures.
