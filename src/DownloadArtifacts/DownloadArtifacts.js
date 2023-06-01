const tl = require("azure-pipelines-task-lib/task");
const rimraf = require('rimraf');
const fs = require('fs');
const axios = require("axios").default;
const nodeStreamZip = require("node-stream-zip");

let axConf, repo;

async function ghGet(url)
{
    return axios.get(`https://api.github.com/repos/${repo}${url}`, axConf);
}

async function main()
{
    try
    {   
        let ghToken, workflowName, branch = false;
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
            branch = tl.getInput("branch");
            artNameFilter = tl.getInput("artNameFilter");
            artNameFilterIsRegex = tl.getInput("artNameFilterIsRegex").toLowerCase() == "true";
        }
        else //Interactive run
        {
            ghToken = process.env.GITHUB_TOKEN;
            repo = process.argv[2];
            workflowName = process.argv[3];
            branch = process.argv[4]
            artNameFilter = process.argv[5];
            artNameFilterIsRegex = false;
        }

        axConf = {headers:
            {
                "Authorization": `token ${ghToken}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Azure DevOps task sevaalekseyev/GithubActions/DownloadArtifacts"
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

        // Retrieve the runs, get the last one
        const branchFilter = branch ? `&branch=${encodeURIComponent(branch)}` : '';
        const runs = (await ghGet(`/actions/workflows/${workflow.id}/runs?per_page=100&status=success${branchFilter}`)).data.workflow_runs
            .sort((l,r) => r.run_number - l.run_number);
        if(runs.length == 0)
        {
            tl.error(`The workflow ${workflow.name} has no successful runs.`);
            process.exit(1);
        }
        const run = runs[0], runID = run.id;
        console.log(`Found the last successful run, started at #${run.run_started_at}.`);

        //Download the artifacts, if any
        let artifacts = (await ghGet(`/actions/runs/${runID}/artifacts`)).data.artifacts;
        if(artNameFilter)
        {
            let f;
            if(artNameFilterIsRegex)
            {
                const re = new RegExp("^" + artNameFilter + "$", "i");
                f = a => a.name.match(re);
            }
            else
            {
                const afl = artNameFilter.toLowerCase();
                f = a => a.name.toLowerCase() == afl;
            }
            artifacts = artifacts.filter(f);
        }
        //Axios config for streaming archive downloads
        const conf = {responseType: "stream", headers: axConf.headers};
        console.log(`Downloading artifacts under ${process.cwd()}.`)

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
                if(fs.existsSync(artName))
                {
                    if(fs.statSync(artName).isDirectory())
                        rimraf.sync(artName);
                    else
                        fs.unlinkSync(artName);
                }
                fs.mkdirSync(artName);
                const zipFile = new nodeStreamZip.async({file: zipFileName});
                await zipFile.extract(null, artName);
                fs.unlinkSync(zipFileName);
            }
            catch(exc)
            {
                tl.warning(`Error while downloading artifact ${artName}: ${exc.stack}`);
                if(!!exc.isAxiosError && exc.response && exc.response.data && exc.response.data.message)
                    tl.warning(exc.response.data.message);
            }                
        }
    }
    catch(exc)
    {
        tl.error(exc.stack);
        if(!!exc.isAxiosError && exc.response && exc.response.data && exc.response.data.message)
            tl.error(exc.response.data.message);
        process.exit(1);
    }
}

main();