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
EXPECT_FAILED = "expectFailed"              # a query item's `expect` assertion did not hold
BUDGET_EXHAUSTED = "budgetExhausted"        # a query ran out of its time budget
MATCH_IMPLAUSIBLE = "matchImplausible"      # a by:"match" resolved to something it cannot be
PLANE_TILTED = "planeTilted"                # a face-anchored plane's face is no longer parallel
SEALED_VOID = "sealedVoid"                  # a cut closed a cavity inside the body
CLEAN_UP_FITTED = "cleanUpFitted"           # Clean Up recognised cylinders on a body (advisory)

ALL = frozenset({
    AMBIGUOUS_REFERENCE, REFERENCE_NOT_FOUND, CANCELLED, TIMED_OUT, STALLED,
    KERNEL_CRASHED, ENGINE_UNAVAILABLE, REPLY_TOO_LARGE, BODY_TOO_LARGE,
    UNKNOWN_OP, BAD_REQUEST, EXPECT_FAILED, BUDGET_EXHAUSTED, MATCH_IMPLAUSIBLE,
    PLANE_TILTED, SEALED_VOID, CLEAN_UP_FITTED,
})

# --- the body slot -----------------------------------------------------------

# A message that is ABOUT a body no longer interpolates that body's name: the
# name came out of the document (on an import, out of the STEP file), and prose
# is the one place untrusted text cannot be told apart from the sidecar's own
# words. The message carries this slot instead, and rides beside `body_id` (ours,
# safe) and `subject` (the name, sanitised).
#
# Word order is why this is a slot and not a suffix the reader appends: "Fillet
# failed on {body}: BOPAlgo_Alert..." puts the name mid-sentence, and no
# append-the-name rule reproduces that.
#
# A consumer that does not substitute shows the literal "{body}", which is
# honest — for an agent it is arguably better than a name, because it is
# obviously a slot and not something to act on. Contract lives in PROTOCOL.md.
BODY_SLOT = "{body}"


class GeomError(ValueError):
    """A geometry error carrying a machine-readable `code` beside its prose.

    Subclasses ValueError SO THAT `rebuild`'s existing per-feature
    `except ValueError` keeps catching it unchanged — every raise site can be
    upgraded in place without touching the handler.

    `code`, `body_id` and `subject` MUST keep their None defaults. These cross a
    ProcessPoolExecutor boundary, and `BaseException.__reduce__` returns
    `(cls, self.args)` — so an exception whose __init__ requires a second
    positional raises TypeError while being UNPICKLED in the parent, replacing a
    clear geometry message with CPython noise at the worst possible moment.
    Covered by a round-trip test.

    They survive that boundary all the same, and it is worth knowing why rather
    than trusting it: CPython's reduce returns a THREE-tuple
    `(cls, self.args, self.__dict__)` when the instance dict is non-empty, so
    plain attributes ride along while a required constructor argument would not.

    `subject` is UNTRUSTED DOCUMENT TEXT — a body or feature name, which on an
    imported assembly is whatever the STEP file's author called it. It is a
    separate field precisely so it never has to be dug back out of a sentence:
    see untrusted.py. `body_id` is ours and is safe to branch on.
    """

    def __init__(self, message, code=None, body_id=None, subject=None):
        super().__init__(message)
        self.code = code
        self.body_id = body_id
        self.subject = subject


def code_of(ex, default=None):
    """The code carried by an exception, or `default`. Tolerates any exception
    type, so callers do not have to know whether a raise site was upgraded."""
    c = getattr(ex, "code", None)
    return c if c else default


def body_id_of(ex, default=None):
    """The body id an exception is about, or `default`."""
    b = getattr(ex, "body_id", None)
    return b if b else default


def subject_of(ex, default=None):
    """The untrusted document text an exception is about, or `default`.

    Sanitise before it reaches a reply — `untrusted.clean(subject_of(ex))`.
    """
    s = getattr(ex, "subject", None)
    return s if s else default
