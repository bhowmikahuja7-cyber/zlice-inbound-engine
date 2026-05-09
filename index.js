const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const app = express();
app.use(bodyParser.json());

// Helper: Aggressively cleans environment variables of quotes and spaces
const cleanEnv = (val) => val ? val.replace(/['"\s]/g, '') : "";

// --- HELPER: GITHUB GRAPHQL (Token Auth) ---
async function queryGitHub(query, variables) {
  const response = await axios.post('https://api.github.com/graphql', { query, variables }, {
    headers: { Authorization: `token ${cleanEnv(process.env.GITHUB_TOKEN)}` }
  });
  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors[0].message));
  }
  return response;
}

// --- FEATURE 1: AUTOMATED CHANNEL CREATION & AUTO-LINKER ---
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const action = req.body.action;

  if (event === 'pull_request' && action === 'opened') {
    const pr = req.body.pull_request;
    const prNumber = pr.number;
    const branchName = pr.head.ref; 
    
    // Auto-Linker: Finds the first number in the branch name
    const issueMatch = branchName.match(/\d+/);
    if (issueMatch) {
      const issueNumber = issueMatch[0];
      const currentBody = pr.body || "";
      
      if (!currentBody.includes(`Closes #${issueNumber}`)) {
        try {
          const owner = cleanEnv(process.env.GITHUB_OWNER);
          const repo = cleanEnv(process.env.GITHUB_REPO);
          await axios.patch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
            body: `${currentBody}\n\n> 🤖 *Zlice Auto-Linker: Automatically linked to* Closes #${issueNumber}`
          }, {
            headers: { Authorization: `token ${cleanEnv(process.env.GITHUB_TOKEN)}` }
          });
        } catch (err) {
          console.error("❌ Auto-Linker failed:", err.message);
        }
      }
    }

    const prTitleFormatted = pr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const repoName = cleanEnv(process.env.GITHUB_REPO).toLowerCase();
    const channelName = `${repoName}-${prNumber}-${prTitleFormatted}`;

    try {
      const guild = client.guilds.cache.first(); 
      if (!guild) return console.log("❌ Discord Guild not found");

      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Discussion for PR #${prNumber}: ${pr.html_url}`,
      });

      newChannel.send(`🚀 **New PR Raised:** #${prNumber}\n**Title:** ${pr.title}\n**Link:** ${pr.html_url}\n\nUse \`Description -> ...\` and \`Label -> ...\` here to sync with the board.`);
    } catch (err) {
      console.error("❌ Failed to create channel:", err);
    }
  }
  res.status(200).send('OK');
});

// --- FEATURE 2: ZERO-CONFIG DYNAMIC SYNC ENGINE ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || !/Labels?\s*->/i.test(message.content)) return;

  try {
    console.log("\n🚀 --- ZERO-CONFIG ENGINE SYNC STARTED --- 🚀");

    const owner = cleanEnv(process.env.GITHUB_OWNER);
    const repo = cleanEnv(process.env.GITHUB_REPO);
    const restHeaders = { headers: { Authorization: `token ${cleanEnv(process.env.GITHUB_TOKEN)}` } };

    // 1. Extract Input
    let labelInput = "";
    const labelMatch = message.content.match(/Labels?\s*->\s*(.+)/i);
    if (labelMatch) labelInput = labelMatch[1].trim().toLowerCase();

    let description = "";
    const descMatch = message.content.match(/Description\s*->\s*([\s\S]*?)(?=Labels?\s*->)/i);
    if (descMatch) description = descMatch[1].trim();
    else description = message.content.split(/Labels?\s*->/i)[0].trim();

    const prMatch = message.channel.name.match(/-(\d+)-/);
    if (!prMatch) return message.reply("❌ Cannot identify PR number from channel name.");
    const prNumber = parseInt(prMatch[1]);

    // 2. Map Discord Label to exact GitHub Column Name
    let targetColumn = "";
    if (labelInput.includes("bug") || labelInput.includes("improvement")) targetColumn = "To-do";
    else if (labelInput.includes("weekday")) targetColumn = "In review(Weekday)";
    else if (labelInput.includes("founders")) targetColumn = "In review(Founders)";
    else if (labelInput.includes("weekend") || labelInput.includes("done")) targetColumn = "Done";

    if (!targetColumn) return message.reply(`⚠️ **Partial Sync:** The label '${labelInput}' doesn't match any board columns.`);

    // 3. Find associated Issue Number from Branch
    let issueNumber = null;
    try {
      const branchName = (await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, restHeaders)).data.head.ref;
      const issueMatch = branchName.match(/\d+/);
      if (issueMatch) issueNumber = parseInt(issueMatch[0]);
    } catch (err) {
      console.log("⚠️ Could not fetch branch details.");
    }

    // 4. Update REST API (Comments and Tags)
    const restBase = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}`;
    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);

    // 5. GraphQL Dynamic Board Resolution
    const dynamicQuery = `
      query($owner: String!, $repo: String!, $pr: Int!, $issue: Int!, $hasIssue: Boolean!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            projectItems(first: 5) { nodes { id project { id title fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }
            closingIssuesReferences(first: 5) {
              nodes { projectItems(first: 5) { nodes { id project { id title fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } } }
            }
          }
          issue(number: $issue) @include(if: $hasIssue) {
            projectItems(first: 5) { nodes { id project { id title fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }
          }
        }
      }`;

    const { data } = await queryGitHub(dynamicQuery, { owner, repo, pr: prNumber, issue: issueNumber || 0, hasIssue: !!issueNumber });
    const repoData = data.data.repository;
    
    let targetItems = [];
    const extractItems = (nodes) => {
      nodes?.forEach(node => {
        if (node?.project?.title.toLowerCase().includes("master")) targetItems.push(node);
      });
    };

    extractItems(repoData.pullRequest?.projectItems?.nodes);
    repoData.pullRequest?.closingIssuesReferences?.nodes?.forEach(issue => extractItems(issue.projectItems?.nodes));
    extractItems(repoData.issue?.projectItems?.nodes);

    if (targetItems.length === 0) {
      return message.reply(`⚠️ **Partial Sync:** Comment and label added, but the card was not found on the Zlice Master Engine board.`);
    }

    // 6. Execute Dynamic Move
    let moveErrors = [];
    for (const item of targetItems) {
      const statusField = item.project.fields.nodes.find(f => f.name === "Status");
      if (!statusField) continue;

      const targetOption = statusField.options.find(o => o.name.toLowerCase() === targetColumn.toLowerCase());
      if (!targetOption) {
        moveErrors.push(`Column '${targetColumn}' not found on board.`);
        continue;
      }

      const moveMutation = `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }`;

      try {
        await queryGitHub(moveMutation, {
          projectId: item.project.id,
          itemId: item.id,
          fieldId: statusField.id,
          optionId: targetOption.id
        });
      } catch (err) {
        moveErrors.push(err.message);
      }
    }

    if (moveErrors.length > 0) {
      return message.reply(`❌ **Board Sync Failed:** ${moveErrors[0]}`);
    }

    message.reply(`✅ **Full Engine Sync Complete!**\n- Comment added\n- Label **${labelInput}** applied\n- Card securely moved to **${targetColumn}**!`);

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply(`❌ **Sync failed at API layer:** ${error.message}`);
  }
});

client.login(cleanEnv(process.env.DISCORD_BOT_TOKEN));

app.get(['/', '/api'], (req, res) => res.send('Zlice Engine Online'));
app.listen(process.env.PORT || 8080, () => console.log('Listening...'));
