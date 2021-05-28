# Description

This description provides a build/release task that starts
a GitHub workflow (an action), waits until the action is complete,
and downloads the published artifacts, if any.

Only https://github.com/ is supported. Enterprise Github is not supported.

The action must be set up with a `workflow_dispatch` trigger. Extra inputs are supported.
