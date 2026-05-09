const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const app = express();
app.use(bodyParser.json());

// Helper to clean Render Environment Variables
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
    
    // Auto-Linker: Aggressively finds the first number in the branch name
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

// --- FEATURE 2: BOARD SYNC LOGIC (THE "BRIDGE" EDITION) ---
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

    // 1. BRIDGE THE GAP: Fetch branch name to explicitly find the Issue Number
    let issueNumber = null;
    try {
      const prUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
      const prRes = await axios.get(prUrl, restHeaders);
      const branchName = prRes.data.head.ref;
      
      const issueMatch = branchName.match(/\d+/); // Grabs the first number in the branch
      if (issueMatch) {
        issueNumber = parseInt(issueMatch[0]);
        console.log(`🌉 Bridged the Gap! PR #${prNumber} -> Branch '${branchName}' -> Issue #${issueNumber}`);
      }
    } catch (err) {
      console.log("⚠️ Could not fetch branch details for bridging.");
    }

    // 2. REST API (Comments & Labels)
    const restBase = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}`;
    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);

    // 3. GRAPHQL API (Query BOTH the PR and the explicitly bridged Issue)
    const findItemQuery = `
      query($owner: String!, $repo: String!, $pr: Int!, $issue: Int!, $hasIssue: Boolean!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            projectItems(first: 10) { nodes { id project { id } } }
            closingIssuesReferences(first: 10) {
              nodes { projectItems(first: 10) { nodes { id project { id } } } }
            }
          }
          issue(number: $issue) @include(if: $hasIssue) {
            projectItems(first: 10) { nodes { id project { id } } }
          }
        }
      }`;

    const itemData = await queryGitHub(findItemQuery, { 
      owner, 
      repo, 
      pr: prNumber, 
      issue: issueNumber || 0, 
      hasIssue: !!issueNumber 
    });
    
    const repoData = itemData.data.data.repository;
    const targetProjectId = cleanEnv(process.env.PROJECT_ID);
    
    // Use a Set so we don't accidentally move the same card twice
    let itemIdsToMove = new Set(); 

    // A. Check PR directly
    if (repoData.pullRequest?.projectItems?.nodes) {
      repoData.pullRequest.projectItems.nodes.forEach(node => {
        if (node.project.id === targetProjectId) itemIdsToMove.add(node.id);
      });
    }
    // B. Check Native GitHub Links
    if (repoData.pullRequest?.closingIssuesReferences?.nodes) {
      repoData.pullRequest.closingIssuesReferences.nodes.forEach(issue => {
        if (issue.projectItems?.nodes) {
          issue.projectItems.nodes.forEach(node => {
            if (node.project.id === targetProjectId) itemIdsToMove.add(node.id);
          });
        }
      });
    }
    // C. Check the Explicitly Bridged Issue (This is what fixes the bug!)
    if (repoData.issue?.projectItems?.nodes) {
      repoData.issue.projectItems.nodes.forEach(node => {
        if (node.project.id === targetProjectId) itemIdsToMove.add(node.id);
      });
    }

    if (itemIdsToMove.size === 0) {
      return message.reply(`⚠️ **Partial Sync:** Comment and label added, but I could not find a visible card on the Master Engine board to move!`);
    }

    let targetOptionId = "";
    if (labelInput.includes("bug") || labelInput.includes("improvement")) {
      targetOptionId = cleanEnv(process.env.OPTION_ID_TODO);
    } else if (labelInput.includes("weekday")) {
      targetOptionId = cleanEnv(process.env.OPTION_ID_REVIEW_FOUNDER);
    } else if (labelInput.includes("weekend")) {
      targetOptionId = cleanEnv(process.env.OPTION_ID_DONE);
    }

    if (!targetOptionId) {
      return message.reply(`⚠️ **Partial Sync:** Label '${labelInput}' added, but it doesn't match any board movement rules.`);
    }

    // Move the cards
    for (const itemId of itemIdsToMove) {
      const moveMutation = `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }`;

      await queryGitHub(moveMutation, {
        projectId: targetProjectId,
        itemId: itemId,
        fieldId: cleanEnv(process.env.STATUS_FIELD_ID),
        optionId: targetOptionId
      });
    }

    message.reply(`✅ **Full Engine Sync Complete!**\n- Comment added\n- Label **${labelInput}** applied\n- ${itemIdsToMove.size} Board card(s) securely moved!`);

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply(`❌ **Sync failed at GraphQL layer:** ${error.message}`);
  }
});

client.login(cleanEnv(process.env.DISCORD_BOT_TOKEN));

app.get(['/', '/api'], (req, res) => res.send('Zlice Engine Online'));
app.listen(process.env.PORT || 8080, () => console.log('Listening...'));
