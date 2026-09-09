# Separate camera/screen receive authority

## Source audit and plan: `b23de52`, 2026-09-09

MDS-13 adds a default-off `video.receive` capability; sending an avatar or screen
and receiving audio confer no visual receive rights. Publisher-owned consent
selects exact currently active camera/screen IDs, with independent capability
checks in server policy and browser key/subscription gates. Grants remain bounded
to at most four current audiovisual sources. No room actor may grant another
publisher's source; no machine may create its own receive grant.

Use a separate optional visual probe and bounded subscription/frame port. Bind
actual session/lease/generation, room, membership and receive revisions, peer,
publication ID/epoch and current track. Sampling uses only an authorized remote
decoded video track, not capture APIs, room mix, URLs, user profiles or arbitrary
tabs. Bound dimensions, bytes, frame count, interval and in-flight work. On
revocation, source/epoch change, timeout or close, stop owned decoding/rendering
resources and discard late frames. Signaling never handles raw frames or keys.

The UI offers camera and screen only when the selected machine has visual receive
capability, without changing existing audio-only editor behavior. It explicitly
states that a granted AI endpoint can decrypt/analyze selected content, not that
it is a blind relay or may record/train/use external providers. Source selection
is never a capture trigger. Automated policy/DOM fixtures remain fully headless.

Ananta owns task/analysis/provider policy; Meet exports only scoped bounded frames.
Test all capability/source combinations, key-delivery denial, selection snapshot
changes, bounded pixels, late-callback cleanup, lease/source revoke and actual
Chromium/Firefox synthetic camera/screen reception before declaring completion.
Keep the public serving build and operator trust unchanged during implementation.

## Policy, source identity and editor implementation, 2026-09-09

Server and browser receive gates now require the source-specific capability for
each of up to four explicitly selected current audiovisual publications. Only
visual-capable recipients receive the registry-issued publication epoch in a
camera/screen announcement; caller-provided epochs are discarded. Repeated
announcements preserve identity; stop/restart advances it. Audio-only signaling
retains its previous shape. A separate mesh read port checks the remote track,
publisher, descriptor, source epoch and current grant without initiating capture.

The editor conditionally adds camera/screen selection, preserves old audio-only
selection shape and rejects stale visual source IDs. Its component is deferred
inside the analysis view: the candidate first exceeded the 1.6MB initial bundle
error budget by 1.91kB; deferral restored a successful 1.59MB build without
changing the budget. The existing 1.5MB warning remains visible.

Pure capability/selection modules and a read-only source port keep policy
separate from decoding (SRP/ISP/DIP). The broad PeerMesh class remains existing
SRP debt; visual decoding belongs to a separate service/factory, not this class.
Focused policy/epoch HTTP-WebSocket tests passed27/27; full candidate frontend
tests passed825/825 in10.94s (including the subsequent visual-port candidate).
Further isolated full checks and Ananta analysis integration remain pending;
this is not public deployment or production evidence.
