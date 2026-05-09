const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

// Initialize Discord Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Initialize Express for GitHub Webhooks
const app = express();
app.use(bodyParser.json());

// Helper: Aggressively cleans environment variables of quotes and spaces
const cleanEnv = (val) => val ? val.replace(/['"\s]/g, '') : "";

// --- HELPER: GITHUB GRAPHQL (Classic Token Auth) ---
async function queryGitHub(query, variables) {
  const response = await axios.post('https://api.github.com/graphql', { query, variables }, {
    headers: { Authorization: `token ${cleanEnv(process.env.GITHUB_TOKEN)}` }
  });
  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors[0].message));
  }
  return response;
}

// =====================================================================
// FEATURE 1: AUTOMATED CHANNEL CREATION & AUTO-LINKER
// =====================================================================
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

    // Dynamic Channel Naming (Format: "number-feature-name")
    const prTitleFormatted = pr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const channelName = `${prNumber}-${prTitleFormatted}`;

    try {
      const guild = client.guilds.cache.first(); 
      if (!guild) return console.log("❌ Discord Guild not found");

      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Discussion for PR #${prNumber}: ${pr.html_url}`,
      });

      newChannel.send(`🚀 **New PR Raised:** #${prNumber}\n**Title:** ${pr.title}\n**Link:** ${pr.html_url}\n\nUse \`Description -> ...\` and/or \`Label -> ...\` here to sync with the board.`);
    } catch (err) {
      console.error("❌ Failed to create channel:", err);
    }
  }
  res.status(200).send('OK');
});

// =====================================================================
// FEATURE 2: MODULAR ZERO-CONFIG SYNC ENGINE
// =====================================================================
client.on('messageCreate', async (message) => {
  // Check which commands are present in the message
  const hasDesc = /Description\s*->/i.test(message.content);
  const hasLabel = /Labels?\s*->/i.test(message.content);

  // STRICT SYNTAX CHECK: Ignore normal chat entirely
  if (message.author.bot || (!hasDesc && !hasLabel)) return;

  try {
    console.log("\n🚀 --- MODULAR ENGINE SYNC STARTED --- 🚀");

    const owner = cleanEnv(process.env.GITHUB_OWNER);
    const repo = cleanEnv(process.env.GITHUB_REPO);
    const restHeaders = { headers: { Authorization: `token ${cleanEnv(process.env.GITHUB_TOKEN)}` } };

    // Extract PR Number dynamically from the new channel name format (starts with number)
    const prMatch = message.channel.name.match(/^(\d+)-/);
    if (!prMatch) return message.reply("❌ Cannot identify PR number from channel name.");
    const prNumber = parseInt(prMatch[1]);
    const restBase = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}`;

    let replyMessage = "✅ **Sync Complete!**\n";

    // ---------------------------------------------------------
    // PROCESS DESCRIPTION (If Provided)
    // ---------------------------------------------------------
    if (hasDesc) {
      // Extracts text after "Description ->" until it hits "Label ->" or the end of the message
      const descMatch = message.content.match(/Description\s*->\s*([\s\S]*?)(?=Labels?\s*->|$)/i);
      if (descMatch && descMatch[1].trim()) {
        const description = descMatch[1].trim();
        await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
        replyMessage += `- Comment added to PR\n`;
      }
    }

    // ---------------------------------------------------------
    // PROCESS LABEL & BOARD MOVEMENT (If Provided)
    // ---------------------------------------------------------
    if (hasLabel) {
      const labelMatch = message.content.match(/Labels?\s*->\s*(.+)/i);
      if (!labelMatch) return;
      const labelInput = labelMatch[1].trim().toLowerCase();

      // 1. Add Label to GitHub PR
      await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);
      replyMessage += `- Label **${labelInput}** applied\n`;

      // 2. Map Label to Board Column Exact Name
      let targetColumn = "";
      if (labelInput.includes("bug") || labelInput.includes("improvement")) targetColumn = "To-do";
      else if (labelInput.includes("weekday")) targetColumn = "In review(Weekday)";
      else if (labelInput.includes("founders")) targetColumn = "In review(Founders)";
      else if (labelInput.includes("weekend") || labelInput.includes("done")) targetColumn = "Done";

      if (!targetColumn) {
        replyMessage += `⚠️ Label doesn't match any movement rules (Board not moved).\n`;
      } else {
        // 3. Dynamic Board Movement
        let issueNumber = null;
        try {
          const branchName = (await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, restHeaders)).data.head.ref;
          const issueMatch = branchName.match(/\d+/);
          if (issueMatch) issueNumber = parseInt(issueMatch[0]);
        } catch (err) { console.log("⚠️ Could not fetch branch details."); }

        const dynamicQuery = `
          query($owner: String!, $repo: String!, $pr: Int!, $issue: Int!, $hasIssue: Boolean!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $pr) {
                projectItems(first: 5) { nodes { id project { id title fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }
                closingIssuesReferences(first: 5) { nodes { projectItems(first: 5) { nodes { id project { id title fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } } } }
              }
              issue(number: $issue) @include(if: $hasIssue) {
                projectItems(first: 5) { nodes { id project { id title fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }
              }
            }
          }`;

        const { data } = await queryGitHub(dynamicQuery, { owner, repo, pr: prNumber, issue: issueNumber || 0, hasIssue: !!issueNumber });
        const repoData = data.data.repository;
        
        let targetItems = [];
        const extractItems = (nodes) => { nodes?.forEach(node => { if (node?.project?.title.toLowerCase().includes("master")) targetItems.push(node); }); };
        extractItems(repoData.pullRequest?.projectItems?.nodes);
        repoData.pullRequest?.closingIssuesReferences?.nodes?.forEach(issue => extractItems(issue.projectItems?.nodes));
        extractItems(repoData.issue?.projectItems?.nodes);

        if (targetItems.length === 0) {
          replyMessage += `⚠️ Card not found on Master Engine board.\n`;
        } else {
          for (const item of targetItems) {
            const statusField = item.project.fields.nodes.find(f => f.name === "Status");
            const targetOption = statusField?.options.find(o => o.name.toLowerCase() === targetColumn.toLowerCase());
            
            if (statusField && targetOption) {
              await queryGitHub(`
                mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
                  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } }
                }`, { projectId: item.project.id, itemId: item.id, fieldId: statusField.id, optionId: targetOption.id });
            }
          }
          replyMessage += `- Card securely moved to **${targetColumn}**!\n`;
        }
      }
    }

    // Send the final success summary
    message.reply(replyMessage);

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply(`❌ **Engine Error:** ${error.message}`);
  }
});

// Login and Start Server
client.login(cleanEnv(process.env.DISCORD_BOT_TOKEN));
app.get(['/', '/api'], (req, res) => res.send('Zlice Engine Online'));
app.listen(process.env.PORT || 8080, () => console.log('Listening...'));
