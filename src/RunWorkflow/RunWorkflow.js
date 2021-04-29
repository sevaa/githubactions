const tl = require("azure-pipelines-task-lib/task");
const fs = require('fs');
const axios = require("axios").default;
const nodeStreamZip = require("node-stream-zip");

let axConf, repo;

async function ghGet(url)
{
    return axios.get(`https://api.github.com/repos/${repo}${url}`, axConf);
}

async function ghPost(url, data)
{
    return axios.post(`https://api.github.com/repos/${repo}${url}`, data, axConf);
}

//t is in milliseconds
async function sleep(t)
{
    return new Promise((r, e) => setTimeout(r, t));
}

function timestamp()
{
    return new Date().getTime();
}

async function main()
{
    try
    {    
        let ghToken, workflowName, ref, timeout, dlArtifacts, workflowInputs;
        if(tl.getVariable("Agent.Version")) //Running from the agent
        {
            const auth = tl.getEndpointAuthorization(tl.getInput("gh"), false).parameters;
            if("accessToken" in auth && auth.accessToken)
                ghToken = auth.accessToken;
            else if("AccessToken" in auth && auth.AccessToken)
                ghToken = auth.AccessToken;
            else
                throw new Error("Unable to retrieve the GitHub token from the service endpoint.")

            repo = tl.getInput("repo");
            workflowName = tl.getInput("workflow");
            ref = tl.getInput("ref");
            timeout = parseInt(tl.getInput("timeout"));
            if(isNaN(timeout))
                timeout = 120;
            dlArtifacts = tl.getBoolInput("dlArtifacts");
            workflowInputs = tl.getInput("inputs");
        }
        else //Interactive run
        {
            ghToken = process.env.GITHUB_TOKEN;
            repo = process.argv[2];
            workflowName = process.argv[3];
            ref = process.argv[4];
            timeout = 120;
            dlArtifacts = true;
            workflowInputs = "";
        }

        if(workflowInputs)
            workflowInputs = workflowInputs.trim();
        if(workflowInputs)
        {
            try
            {
                workflowInputs = JSON.parse(workflowInputs);
            }
            catch(e)
            {
                tl.warning("The inputs parameter is not a valid JSON document.");
                workflowInputs = false;
            }
        }
        else
            workflowInputs = false;

        if(!ref)
            ref = "master";
        const workflowParams = {ref: ref};
        if(workflowInputs)
            workflowParams.inputs = workflowInputs;

        timeout *= 60000; //min to ms
        axConf = {headers:
            {
                "Authorization": `token ${ghToken}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Azure DevOps task sevaalekseyev/GithubActiond/RunWorkflow"
            }};

        //Find the right workflow
        const workflows = (await ghGet(`/actions/workflows`, axConf)).data.workflows;
        let workflow;
        if(workflows.length == 0)
            throw new Error("There are no workflows in the specified repository.");
        if(workflowName)
        {
            workflow = workflows.find(wf => wf.name.toLowerCase() == workflowName.toLowerCase());
            if(!workflow)
                throw new Error(`There is no workflow named ${workflowName} in the repository.`);
        }
        else
            workflow = workflows[0];
        console.log(`Found the workflow, #${workflow.id}/${workflow.name}.`);

        // Runs aren't sync. There's no result from run start. Need past run IDs.
        const prevRuns = (await ghGet("/actions/runs")).data.workflow_runs;
        const prevRunIDs = prevRuns.map(r => r.id);

        // Start the workflow run.
        console.log("Starting the action...")
        await ghPost(`/actions/workflows/${workflow.id}/dispatches`, workflowParams);

        const startTime = timestamp();        
        // The run won't start right away. Crude workaround: timeout loop
        let runID;
        while(true)
        {
            await sleep(500);
            const runs = (await ghGet("/actions/runs")).data.workflow_runs;
            const theRun = runs.find(r => r.name == workflow.name && prevRunIDs.indexOf(r.id) < 0);
            //The situation where the very same workflow has been invoked elsewhere in this narrow time
            //window is not processed. This is a race condition. 
            if(theRun)
            {
                runID = theRun.id;
                console.log(`https://github.com/${repo}/actions/runs/${runID}`);
                break;
            }
            if(timestamp() - startTime > timeout)
                throw new Error("The timeout has expired while waiting for the action to start.");            
        }

        // Busy loop until it's over :( Oh well.
        // For better logging on the AzdevOps side, we could monitor jobs and steps
        let waitTime = 1000; //Just in case, check every second in the very beginning. 
        const runStartTime = timestamp();        
        let run;
        while(true)
        {
            await sleep(waitTime);
            const now = timestamp();
            if(now - runStartTime > 60000) //Over a minute - check every 30 sec
                waitTime = 30000;
            run = (await ghGet(`/actions/runs/${runID}`)).data;
            if(run.status == 'completed')
            {
                console.log(`The workflow run is complete.`);
                if(run.conclusion == "failure")
                    throw new Error("The action run ended with a failure, review the details on GitHub.");
                break;
            }
            if(timestamp() - startTime > timeout)
                throw new Error("The action has timed out.");
        }
        //TODO: publish some run parameters maybe?

        //We are here. Download the artifacts, if any
        if(dlArtifacts)
        {
            const artifacts = (await ghGet(`/actions/runs/${runID}/artifacts`)).data.artifacts;
            //Axios config for streaming archive downloads
            const conf = {responseType: "stream", headers: axConf.headers};

            for(const artifact of artifacts)
            {
                const artName = artifact.name;
                try
                {
                    console.log(`Downloading artifact ${artName}...`);
                    const zipDownload = await axios.get(artifact.archive_download_url, conf);
                    const zipFileName = `${artName}.zip`;
                    const fst = fs.createWriteStream(zipFileName);
                    zipDownload.data.pipe(fst);
                    //Not sure about this line. Will error on read end close the write end?
                    await new Promise((resolve, err) => {fst.on("finish", resolve); fst.on("error", err); zipDownload.data.on("error", err)});

                    const st = fs.statSync(zipFileName);
                    console.log(`Downloaded artifact ${artName} - ${st.size} bytes, unzipping...`);

                    //Unzip it. Ideally, unzip straight from the web response stream would be cute.
                    fs.mkdirSync(artName);
                    const zipFile = new nodeStreamZip.async({file: zipFileName});
                    await zipFile.extract(null, artName);
                    fs.unlinkSync(zipFileName);
                }
                catch(exc)
                {
                    tl.warning(`Error while downloading artifact ${artName}: ${exc.stack}`);
                    if(!!exc.isAxiosError)
                        tl.warning(exc.response.data.message);
                }                
            }
        }
        else
            console.log("Artifact download skipped.")
    }
    catch(exc)
    {
        tl.error(exc.stack);
        if(!!exc.isAxiosError)
            tl.error(exc.response.data.message);
        process.exit(1);
    }
}

main();