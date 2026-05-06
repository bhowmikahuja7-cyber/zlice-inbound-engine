const axios = require('axios');

async function printAllColumnIds() {
  try {
    const response = await axios.post('https://api.github.com/graphql', {
      query: `query { node(id: "PVTSSF_lAH0Da11S84BW2mQzhSHLw") { ... on ProjectV2SingleSelectField { options { id name } } } }`
    }, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    });

    console.log("\n✅ MASTER LIST OF COLUMN IDS:\n");
    response.data.data.node.options.forEach(opt => {
      console.log(`Column Name: "${opt.name}"  ==>  ID: ${opt.id}`);
    });
    console.log("\n");
  } catch (e) {
    console.log("Error! Make sure your GitHub token is saved in Secrets.", e.message);
  }
}

printAllColumnIds();