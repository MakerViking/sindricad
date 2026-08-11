"""Machine-readable error codes for the sidecar wire protocol.

Errors used to be PROSE ONLY. That is fine for a human reading a toast and
useless for anything that has to branch — and the app already depends on one
de-facto code today: `repickReference.ambiguousDiagFor` matches the exact string
"ambiguous nearest pick" across the language boundary, so rewording a message in
Python silently kills the Re-pick affordance in TypeScript. A `code` field makes
that dependency explicit and reworded-message-proof.

WHY A SEPARATE MODULE: `builder` imports `geom_select`, so a shared exception
cannot live in `geom_select` without a cycle, and `builder` raises non-selector
errors so it cannot live there either. Nothing in here imports OCCT, so it is
free to import from a worker.

ADDING A CODE is a pure addition — every consumer treats an unrecognised code as
"unclassified" (the TS type carries a `(string & {})` member for exactly this),
so a new code never breaks an older frontend. REMOVING or RENAMING one is a
breaking change to the wire contract.

Deliberately NOT coded yet, because nothing branches on them: nothingToExport,
booleanNoOp, and the per-feature geometry failures (filletFailed and friends).
Trigger to add them: the first caller — agent, UI or test — that wants to treat
one differently from a generic failure.
"""

# --- the vocabulary ----------------------------------------------------------
# Flat lowerCamel, matching the shipped `ResolveDiag.kind` value "edgeOpFailed".

AMBIGUOUS_REFERENCE = "ambiguousReference"  # a selector matched several candidates
REFERENCE_NOT_FOUND = "referenceNotFound"   # a selector matched nothing
CANCELLED = "cancelled"                     # the user pressed Cancel
TIMED_OUT = "timedOut"                      # a hard wall-clock job timeout
STALLED = "stalled"                         # no worker heartbeat; the pool was restarted
KERNEL_CRASHED = "kernelCrashed"            # the geometry worker died
ENGINE_UNAVAILABLE = "engineUnavailable"    # the worker pool could not be started
REPLY_TOO_LARGE = "replyTooLarge"           # the whole reply exceeded the frame cap
BODY_TOO_LARGE = "bodyTooLarge"             # one body exceeded the frame cap
UNKNOWN_OP = "unknownOp"                    # no such op (the capability-probe answer)
BAD_REQUEST = "badRequest"                  # malformed/oversized input, refused up front

ALL = frozenset({
    AMBIGUOUS_REFERENCE, REFERENCE_NOT_FOUND, CANCELLED, TIMED_OUT, STALLED,
    KERNEL_CRASHED, ENGINE_UNAVAILABLE, REPLY_TOO_LARGE, BODY_TOO_LARGE,
    UNKNOWN_OP, BAD_REQUEST,
})


class GeomError(ValueError):
    """A geometry error carrying a machine-readable `code` beside its prose.

    Subclasses ValueError SO THAT `rebuild`'s existing per-feature
    `except ValueError` keeps catching it unchanged — every raise site can be
    upgraded in place without touching the handler.

    `code` MUST keep its None default. These cross a ProcessPoolExecutor
    boundary, and `BaseException.__reduce__` returns `(cls, self.args)` — so an
    exception whose __init__ requires a second positional raises TypeError while
    being UNPICKLED in the parent, replacing a clear geometry message with
    CPython noise at the worst possible moment. Covered by a round-trip test.
    """

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def code_of(ex, default=None):
    """The code carried by an exception, or `default`. Tolerates any exception
    type, so callers do not have to know whether a raise site was upgraded."""
    c = getattr(ex, "code", None)
    return c if c else default
