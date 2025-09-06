import fs from 'fs-extra';

const poolAddress = "0xBb7EfF3E685c6564F2F09DD90b6C05754E3BDAC0";

async function checkPoolData() {
  try {
    const data = await fs.readJson('./priceData.json');
    
    console.log('File structure:');
    console.log('- Has pools?', !!data.pools);
    console.log('- Has version?', !!data.version);
    console.log('- Pool keys:', data.pools ? Object.keys(data.pools) : 'N/A');
    
    if (data.pools && data.pools[poolAddress]) {
      const poolData = data.pools[poolAddress];
      console.log(`\nData for pool ${poolAddress}:`);
      console.log('- Latest price:', poolData.latestPrice);
      console.log('- Last updated:', poolData.lastUpdated);
      console.log('- History length:', poolData.history ? poolData.history.length : 0);
      
      if (poolData.history && poolData.history.length > 0) {
        console.log('- First history entry:', poolData.history[0]);
        console.log('- Last history entry:', poolData.history[poolData.history.length - 1]);
      }
      
      console.log('- OHLC data:');
      if (poolData.ohlc) {
        Object.entries(poolData.ohlc).forEach(([interval, data]) => {
          console.log(`  ${interval}: ${Array.isArray(data) ? data.length : 0} entries`);
        });
      }
    } else {
      console.log(`\nNo data found for pool ${poolAddress}`);
      
      // Check with lowercase
      const lowerPool = poolAddress.toLowerCase();
      if (data.pools && data.pools[lowerPool]) {
        console.log(`But found data for lowercase version: ${lowerPool}`);
      }
    }
  } catch (error) {
    console.error('Error reading file:', error.message);
  }
}

checkPoolData();