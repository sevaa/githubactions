# Description

This extension provides a build/release task for Azure DevOps pipelines
 that starts a GitHub workflow (an action), waits until the action is complete,
and downloads the published artifacts, if any.

Another task only downloads the artifacts from the last successful run.

Only https://github.com/ is supported. Enterprise GitHub is not supported.

For the "Run Workflow" task, the action must be set up with a `workflow_dispatch` trigger in the workflow's YAML file on GitHub. Extra inputs are supported, as long as they are declared in the YAML under `on/workflow_dispatch/inputs`.
