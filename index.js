const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const app = express();
app.use(bodyParser.json());

// Helper to clean Render Environment Variables of quotes and spaces
const cleanEnv = (val) => val ? val.replace(/['"]/g, '').trim() : "";

// --- HELPER: GITHUB GRAPHQL ---
async function queryGitHub(query, variables) {
  const response = await axios.post('https://api.github.com/graphql', { query, variables }, {
    headers: { Authorization: `Bearer ${cleanEnv(process.env.GITHUB_TOKEN)}` }
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
    
    // 🤖 ZLICE AUTO-LINKER: Aggressively finds the first number in the branch name
    const issueMatch = branchName.match(/\d+/);
    if (issueMatch) {
      const issueNumber = issueMatch[0];
      const currentBody = pr.body || "";
      
      if (!currentBody.includes(`Closes #${issueNumber}`)) {
        try {
          const owner = cleanEnv(process.env.GITHUB_OWNER);
          const repo = cleanEnv(process.env.GITHUB_REPO);
          const updateUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
          
          await axios.patch(updateUrl, {
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

// --- FEATURE 2: BOARD SYNC LOGIC (NAME-TARGETING EDITION) ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || !/Labels?\s*->/i.test(message.content)) return;

  try {
    console.log("\n🚀 --- NEW ENGINE SYNC STARTED --- 🚀");

    let description = "";
    let labelInput = "";

    const labelMatch = message.content.match(/Labels?\s*->\s*(.+)/i);
    if (labelMatch) labelInput = labelMatch[1].trim().toLowerCase();

    const descMatch = message.content.match(/Description\s*->\s*([\s\S]*?)(?=Labels?\s*->)/i);
    if (descMatch) {
      description = descMatch[1].trim();
    } else {
      const parts = message.content.split(/Labels?\s*->/i);
      description = parts[0].trim();
    }

    const prMatch = message.channel.name.match(/-(\d+)-/);
    if (!prMatch) return message.reply("❌ Cannot identify PR number from channel name.");
    const prNumber = parseInt(prMatch[1]);

    const owner = cleanEnv(process.env.GITHUB_OWNER);
    const repo = cleanEnv(process.env.GITHUB_REPO);
    const restHeaders = { headers: { Authorization: `token ${cleanEnv(process.env.GITHUB_TOKEN)}` } };

    let issueNumber = null;
    try {
      const prUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
      const prRes = await axios.get(prUrl, restHeaders);
      const branchName = prRes.data.head.ref;
      
      const issueMatch = branchName.match(/\d+/);
      if (issueMatch) issueNumber = parseInt(issueMatch[0]);
    } catch (err) {
      console.log("⚠️ Could not fetch branch details.");
    }

    // 1. REST API
    const restBase = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}`;
    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);

    // 2. GRAPHQL API
    const findItemQuery = `
      query($owner: String!, $repo: String!, $pr: Int!, $issue: Int!, $hasIssue: Boolean!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            projectItems(first: 10) { nodes { id project { id title } } }
            closingIssuesReferences(first: 10) {
              nodes { projectItems(first: 10) { nodes { id project { id title } } } }
            }
          }
          issue(number: $issue) @include(if: $hasIssue) {
            projectItems(first: 10) { nodes { id project { id title } } }
          }
        }
      }`;

    const itemData = await queryGitHub(findItemQuery, { 
      owner, repo, pr: prNumber, issue: issueNumber || 0, hasIssue: !!issueNumber 
    });
    
    const repoData = itemData.data.data.repository;
    
    let itemsToMove = []; 
    let seenIds = new Set();

    const extractItems = (nodes) => {
      if (!nodes) return;
      nodes.forEach(node => {
        if (node && node.id && node.project && node.project.id && !seenIds.has(node.id)) {
          const title = (node.project.title || "").toLowerCase();
          // THE ULTIMATE FILTER: Only select boards with "master" in the name
          if (title.includes("master")) {
            seenIds.add(node.id);
            itemsToMove.push({ itemId: node.id, projectId: node.project.id, title: node.project.title });
          }
        }
      });
    };

    if (repoData.pullRequest?.projectItems?.nodes) extractItems(repoData.pullRequest.projectItems.nodes);
    if (repoData.pullRequest?.closingIssuesReferences?.nodes) {
      repoData.pullRequest.closingIssuesReferences.nodes.forEach(issue => extractItems(issue.projectItems?.nodes));
    }
    if (repoData.issue?.projectItems?.nodes) extractItems(repoData.issue.projectItems.nodes);

    if (itemsToMove.length === 0) {
      return message.reply(`⚠️ **Partial Sync:** Could not find this card on any board containing the word 'Master'. Ensure it is physically added to the Master Engine board.`);
    }

    let targetOptionId = "";
    if (labelInput.includes("bug") || labelInput.includes("improvement")) targetOptionId = cleanEnv(process.env.OPTION_ID_TODO);
    else if (labelInput.includes("weekday")) targetOptionId = cleanEnv(process.env.OPTION_ID_REVIEW_FOUNDER);
    else if (labelInput.includes("weekend")) targetOptionId = cleanEnv(process.env.OPTION_ID_DONE);

    if (!targetOptionId) return message.reply(`⚠️ **Partial Sync:** Label '${labelInput}' added, but it doesn't match any movement rules.`);

    // 3. SHIELDED EXECUTION
    let moveErrors = [];
    for (const item of itemsToMove) {
      const moveMutation = `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }`;

      try {
        await queryGitHub(moveMutation, {
          projectId: item.projectId,
          itemId: item.itemId,
          fieldId: cleanEnv(process.env.STATUS_FIELD_ID),
          optionId: targetOptionId
        });
      } catch (err) {
        moveErrors.push(`Failed on board '${item.title}': ${err.message}`);
      }
    }

    if (moveErrors.length > 0 && itemsToMove.length === moveErrors.length) {
      // If ALL movement attempts failed, report the specific error so we can fix it!
      return message.reply(`❌ **Sync failed during board movement.** The IDs in your Render environment (STATUS_FIELD_ID or OPTION_IDs) do not match the board '${itemsToMove[0].title}'. \n**Error:** ${moveErrors[0]}`);
    }

    message.reply(`✅ **Full Engine Sync Complete!**\n- Comment added\n- Label **${labelInput}** applied\n- Board card securely moved on '${itemsToMove[0].title}'!`);

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply(`❌ **Sync failed at GraphQL layer:** ${error.message}`);
  }
});

client.login(cleanEnv(process.env.DISCORD_BOT_TOKEN));

app.get(['/', '/api'], (req, res) => res.send('Zlice Engine Online'));
app.listen(process.env.PORT || 8080, () => console.log('Listening...'));
