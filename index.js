import { ethers, Contract, JsonRpcProvider, WebSocketProvider } from "ethers";
import express from "express";
import cors from "cors";
import fs from "fs-extra";
import dotenv from "dotenv";
import IUniswapV3PoolABI from "./artifacts/IUniswapV3PoolAbi.json" assert { type: "json" };

// Load environment variables
dotenv.config();

// Configuration
const isLocalChain = process.env.CHAIN === "local";
const providerUrl = isLocalChain ? "http://localhost:8545" : (process.env.RPC_URL || "https://rpc.ankr.com/monad_testnet");
const wsProviderUrl = "wss://monad-testnet.rpc.ankr.com/ws"; // WebSocket URL for events (may not be available)
// Removed hardcoded default pool - pool parameter is now required for all endpoints
const dataFilePath = isLocalChain ? "./priceData_local.json" : "./priceData.json";
const PORT = process.env.PORT || 3001;
const USE_WEBSOCKET = false; // Disable WebSocket for now as Monad testnet may not support it

// Standard datapoint limits per interval to ensure consistency
const DATAPOINT_LIMITS = {
  "1m": 100,
  "5m": 100,
  "15m": 100,
  "30m": 100,
  "1h": 100,
  "6h": 100,
  "12h": 100,
  "24h": 100,
  "1w": 100,
  "1M": 100
};

// Global providers
let provider;
let wsProvider;

// Pool-specific data storage and contracts
const poolsData = new Map(); // Map<poolAddress, poolData>
const poolContracts = new Map(); // Map<poolAddress, Contract>
const wsPoolContracts = new Map(); // Map<poolAddress, Contract>
const lastProcessedBlocks = new Map(); // Map<poolAddress, blockNumber>

// Initialize pool data structure
const createPoolData = () => ({
  latestPrice: null,
  history: [],
  lastUpdated: null,
  ohlc: {
    "1m": [],
    "5m": [],
    "15m": [],
    "30m": [],
    "1h": [],
    "6h": [],
    "12h": [],
    "24h": [],
    "1w": [],
    "1M": []
  },
  volume: {
    "24h": 0,
    "7d": 0,
    "30d": 0,
    total: 0,
    lastReset: Date.now()
  }
});

// Initialize default pool data reference (will be set after loading file)
let priceData = null;

// Helper function to validate Ethereum address
const isValidAddress = (address) => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

// Initialize a new pool with initial price fetch
const initializePool = async (poolAddress) => {
  try {
    console.log(`Initializing new pool: ${poolAddress}`);
    
    // Fetch initial price
    await updatePrice(poolAddress);
    
    // Set up event listeners for this pool
    await setupEventListenersForPool(poolAddress);
    
    // Set up periodic price updates for this pool
    setInterval(() => updatePrice(poolAddress), 5000);
    
    console.log(`Pool ${poolAddress} initialized successfully`);
  } catch (error) {
    console.error(`Error initializing pool ${poolAddress}:`, error);
  }
};

// Helper function to get or create pool data
const getPoolData = (poolAddress) => {
  const normalizedAddress = poolAddress.toLowerCase();
  
  if (!poolsData.has(normalizedAddress)) {
    const newPoolData = createPoolData();
    poolsData.set(normalizedAddress, newPoolData);
  }
  
  return poolsData.get(normalizedAddress);
};

// Helper function to get or create pool contract
const getPoolContract = async (poolAddress) => {
  const normalizedAddress = poolAddress.toLowerCase();
  
  if (!poolContracts.has(normalizedAddress)) {
    if (!provider) {
      throw new Error("Provider not initialized");
    }
    
    const contract = new Contract(poolAddress, IUniswapV3PoolABI.abi, provider);
    poolContracts.set(normalizedAddress, contract);
  }
  
  return poolContracts.get(normalizedAddress);
};

// Initialize express app
const app = express();
app.use(cors()); // Enable CORS for all routes
app.use(express.json());

// Track pools being initialized
const poolsInitializing = new Set();

// Middleware to parse and validate pool parameter
const parsePoolAddress = async (req, res, next) => {
  // Get pool address from query parameter
  const poolAddress = req.query.pool || req.query.poolAddress;
  
  // Check if pool parameter is provided
  if (!poolAddress) {
    return res.status(400).json({
      error: "Missing required parameter: pool",
      message: "Pool address is required. Use ?pool=0x... or ?poolAddress=0x..."
    });
  }
  
  // Validate the address format
  if (!isValidAddress(poolAddress)) {
    return res.status(400).json({
      error: "Invalid pool address format",
      message: "Pool address must be a valid Ethereum address (0x followed by 40 hexadecimal characters)"
    });
  }
  
  // Normalize and attach to request
  req.poolAddress = poolAddress;
  req.normalizedPoolAddress = poolAddress.toLowerCase();
  
  // Check if this is a new pool that needs initialization
  const normalizedAddress = poolAddress.toLowerCase();
  if (!poolsData.has(normalizedAddress) && !poolsInitializing.has(normalizedAddress)) {
    poolsInitializing.add(normalizedAddress);
    
    // Create pool data immediately
    const newPoolData = createPoolData();
    poolsData.set(normalizedAddress, newPoolData);
    
    // Initialize pool asynchronously
    initializePool(poolAddress).finally(() => {
      poolsInitializing.delete(normalizedAddress);
    });
  }
  
  next();
};

// Backfill historical OHLC data from existing price history
const backfillHistoricalOHLC = (poolData) => {
  if (!poolData || poolData.history.length === 0) return;

  const intervals = {
    "1m": 1 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    "1M": 30 * 24 * 60 * 60 * 1000
  };

  // Only backfill if OHLC arrays are empty or very small
  Object.entries(intervals).forEach(([interval, ms]) => {
    if (poolData.ohlc[interval] && poolData.ohlc[interval].length >= 2) {
      return; // Skip if we already have sufficient data
    }

    // Clear existing data for clean backfill
    poolData.ohlc[interval] = [];

    // Process each historical price point
    poolData.history.forEach(historyItem => {
      const { price, timestamp } = historyItem;
      const currentOHLC = poolData.ohlc[interval];

      // Calculate the candle start time (rounded down to interval boundary)
      const roundedTimestamp = Math.floor(timestamp / ms) * ms;

      // If no candles exist or the last candle is for a different time period, create a new one
      if (currentOHLC.length === 0 || 
          currentOHLC[currentOHLC.length - 1].timestamp !== roundedTimestamp) {
        
        // For continuity: new candle's open should equal previous candle's close
        const openPrice = currentOHLC.length > 0 ? currentOHLC[currentOHLC.length - 1].close : price;
        
        currentOHLC.push({
          timestamp: roundedTimestamp,
          open: openPrice,
          high: price,
          low: price,
          close: price
        });
      } else {
        // Update the current candle
        const currentCandle = currentOHLC[currentOHLC.length - 1];
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low = Math.min(currentCandle.low, price);
        currentCandle.close = price;
      }
    });

    console.log(`Backfilled ${poolData.ohlc[interval].length} candles for ${interval} interval`);
  });
};

// Generate longer intervals from shorter interval data
const generateIntervalsFromExisting = (poolData) => {
  // Generate 6h from 1h data
  if (poolData.ohlc["1h"] && poolData.ohlc["1h"].length > 0) {
    poolData.ohlc["6h"] = generateLongerInterval(poolData.ohlc["1h"], 6 * 60 * 60 * 1000);
    console.log(`Generated ${poolData.ohlc["6h"].length} 6h candles from 1h data`);
  }
  
  // Generate 12h from 1h data
  if (poolData.ohlc["1h"] && poolData.ohlc["1h"].length > 0) {
    poolData.ohlc["12h"] = generateLongerInterval(poolData.ohlc["1h"], 12 * 60 * 60 * 1000);
    console.log(`Generated ${poolData.ohlc["12h"].length} 12h candles from 1h data`);
  }
  
  // If no 1h data, try generating from 5m data
  else if (poolData.ohlc["5m"] && poolData.ohlc["5m"].length > 0) {
    // First generate 1h from 5m
    poolData.ohlc["1h"] = generateLongerInterval(poolData.ohlc["5m"], 60 * 60 * 1000);
    console.log(`Generated ${poolData.ohlc["1h"].length} 1h candles from 5m data`);
    
    // Then generate 6h and 12h from the new 1h data
    poolData.ohlc["6h"] = generateLongerInterval(poolData.ohlc["1h"], 6 * 60 * 60 * 1000);
    poolData.ohlc["12h"] = generateLongerInterval(poolData.ohlc["1h"], 12 * 60 * 60 * 1000);
    console.log(`Generated ${poolData.ohlc["6h"].length} 6h and ${poolData.ohlc["12h"].length} 12h candles`);
  }
};

// Helper function to generate longer interval candles from shorter ones
const generateLongerInterval = (sourceCandles, targetIntervalMs) => {
  if (!sourceCandles || sourceCandles.length === 0) return [];
  
  const result = [];
  
  sourceCandles.forEach(candle => {
    const targetTimestamp = Math.floor(candle.timestamp / targetIntervalMs) * targetIntervalMs;
    
    // Find existing candle for this time period or create new one
    let targetCandle = result.find(c => c.timestamp === targetTimestamp);
    
    if (!targetCandle) {
      targetCandle = {
        timestamp: targetTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      };
      result.push(targetCandle);
    } else {
      // Update existing candle
      targetCandle.high = Math.max(targetCandle.high, candle.high);
      targetCandle.low = Math.min(targetCandle.low, candle.low);
      targetCandle.close = candle.close; // Last close becomes the period close
    }
  });
  
  // Sort by timestamp
  return result.sort((a, b) => a.timestamp - b.timestamp);
};

// Validate and fix OHLC continuity
const validateAndFixOHLCContinuity = (poolData) => {
  let fixCount = 0;
  
  Object.entries(poolData.ohlc).forEach(([interval, candles]) => {
    for (let i = 1; i < candles.length; i++) {
      const prevCandle = candles[i - 1];
      const currCandle = candles[i];
      
      // Check if close of previous candle equals open of current candle
      if (prevCandle.close !== currCandle.open) {
        console.log(`OHLC continuity issue detected in ${interval}: candle[${i-1}].close (${prevCandle.close}) != candle[${i}].open (${currCandle.open})`);
        
        // Fix by adjusting current candle's open to previous candle's close
        currCandle.open = prevCandle.close;
        fixCount++;
      }
    }
  });
  
  if (fixCount > 0) {
    console.log(`Fixed ${fixCount} OHLC continuity issues`);
  }
  
  return fixCount;
};

// Create or load existing data file
const initializeDataFile = async () => {
  try {
    if (await fs.pathExists(dataFilePath)) {
      const data = await fs.readJson(dataFilePath);
      
      // Check if it's the new format (version 2 or has pools structure)
      if (data.pools) {
        // Load all pools data (normalize addresses to lowercase)
        for (const [poolAddress, poolData] of Object.entries(data.pools)) {
          poolsData.set(poolAddress.toLowerCase(), poolData);
        }
        
        // Load volume history
        if (data.volumeHistory) {
          volumeHistory.push(...data.volumeHistory);
        }
        
        console.log(`Loaded ${Object.keys(data.pools).length} pools from file`);
        
        // Validate and fix OHLC continuity for all pools
        for (const [poolAddress, poolData] of poolsData.entries()) {
          const fixCount = validateAndFixOHLCContinuity(poolData);
          if (fixCount > 0) {
            console.log(`Fixed ${fixCount} continuity issues for pool ${poolAddress}`);
          }
        }
        
        // No default pool - priceData will be null until a pool is accessed
        priceData = null;
      } else {
        // Old format - migrate data to pools structure
        console.log("Warning: Old format data file detected. Creating new empty data file.");
        
        // Create new empty data file
        const initialData = {
          pools: {},
          volumeHistory: [],
          version: 2,
          lastSaved: Date.now()
        };
        await fs.writeJson(dataFilePath, initialData);
        console.log("Created new empty data file with v2 format");
      }
      
      console.log("Loaded existing price data");
    } else {
      // No file exists - create empty pools structure
      priceData = null;
      
      // Create new file with new format
      const initialData = {
        pools: {},
        volumeHistory: [],
        version: 2,
        lastSaved: Date.now()
      };
      await fs.writeJson(dataFilePath, initialData);
      console.log("Created new price data file with v2 format");
    }
  } catch (error) {
    console.error("Error initializing data file:", error);
  }
};

// Fetch the latest price from Uniswap pool
const fetchLatestPrice = async (poolAddress) => {
  try {
    const poolContract = await getPoolContract(poolAddress);
    if (!poolContract) {
      console.error(`No pool contract for ${poolAddress}`);
      return null;
    }
    
    // Verify the contract is a valid Uniswap V3 pool
    try {
      const slot0 = await poolContract.slot0();
      const sqrtPriceX96 = slot0.sqrtPriceX96;
      
      if (!sqrtPriceX96 || sqrtPriceX96.toString() === '0') {
        console.error(`Invalid price data for pool ${poolAddress}`);
        return null;
      }
      
      const price = (Number(sqrtPriceX96) ** 2) / 2 ** 192;
      return price;
    } catch (contractError) {
      console.error(`Pool ${poolAddress} may not be a valid Uniswap V3 pool:`, contractError.message);
      return null;
    }
  } catch (error) { 
    console.error(`Error fetching price for ${poolAddress}:`, error.message);
    return null;
  }
};

// Query past events periodically for a specific pool
const queryPastEvents = async (poolAddress) => {
  try {
    const poolContract = await getPoolContract(poolAddress);
    if (!poolContract) return;
    
    const currentBlock = await provider.getBlockNumber();
    
    // Get last processed block for this pool
    const normalizedAddress = poolAddress.toLowerCase();
    let lastProcessedBlock = lastProcessedBlocks.get(normalizedAddress) || 0;
    
    // First run - start from current block
    if (lastProcessedBlock === 0) {
      lastProcessedBlock = currentBlock - 100; // Start from 100 blocks ago
    }
    
    // Don't query if no new blocks
    if (currentBlock <= lastProcessedBlock) return;
    
    console.log(`Querying events from block ${lastProcessedBlock + 1} to ${currentBlock}`);
    
    // Try both standard and extended V3 Swap event signatures
    const eventSignatures = [
      'Swap(address,address,int256,int256,uint160,uint128,int24)', // Standard V3
      'Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)' // Extended V3 (PancakeSwap)
    ];
    
    let allEvents = [];
    
    // Query events in chunks to avoid timeouts
    const blockRange = currentBlock - lastProcessedBlock;
    const chunkSize = 100;
    
    for (let i = lastProcessedBlock + 1; i <= currentBlock; i += chunkSize) {
      const fromBlock = i;
      const toBlock = Math.min(i + chunkSize - 1, currentBlock);
      
      // Try each event signature
      for (const eventSig of eventSignatures) {
        try {
          const filter = {
            address: poolAddress,
            topics: [ethers.id(eventSig)],
            fromBlock: fromBlock,
            toBlock: toBlock
          };
          
          const logs = await provider.getLogs(filter);
          if (logs.length > 0) {
            console.log(`Found ${logs.length} swap events with signature: ${eventSig}`);
            allEvents = allEvents.concat(logs);
          }
        } catch (err) {
          // Silently continue - some pools may not have extended events
        }
      }
    }
    
    // Process all found events
    for (const log of allEvents) {
      try {
        // Manually parse the swap event
        const sender = '0x' + log.topics[1].slice(26);
        const recipient = '0x' + log.topics[2].slice(26);
        
        // Decode the data - handle both standard and extended formats
        const dataTypes = log.data.length > 450 
          ? ['int256', 'int256', 'uint160', 'uint128', 'int24', 'uint128', 'uint128'] // Extended
          : ['int256', 'int256', 'uint160', 'uint128', 'int24']; // Standard
          
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(dataTypes, log.data);
        const [amount0, amount1, sqrtPriceX96, liquidity, tick] = decoded;
          
        // Get pool data for this pool
        const poolData = getPoolData(poolAddress);
        
        // Calculate volume (assuming token1 is USD - you'd need to verify this)
        const volumeUSD = calculateSwapVolume(amount0, amount1, false);
        updateVolume(poolData, volumeUSD);
        
        console.log(`Pool ${poolAddress}: Processed swap event: Volume $${volumeUSD.toFixed(2)}`);
      } catch (error) {
        console.error('Error processing swap event:', error.message);
      }
    }
    
    // Update last processed block for this pool
    lastProcessedBlocks.set(normalizedAddress, currentBlock);
  } catch (error) {
    console.error("Error querying past events:", error);
  }
};

// Set up event listeners for swap events for a specific pool
const setupEventListenersForPool = async (poolAddress) => {
  try {
    if (USE_WEBSOCKET) {
      // Try WebSocket connection if enabled
      try {
        if (!wsProvider) {
          wsProvider = new WebSocketProvider(wsProviderUrl);
        }
        const wsPoolContract = new Contract(poolAddress, IUniswapV3PoolABI.abi, wsProvider);
        
        // Get token addresses to determine which is USD
        const token0 = await wsPoolContract.token0();
        const token1 = await wsPoolContract.token1();
        
        console.log("Token0:", token0);
        console.log("Token1:", token1);
        
        // Store WebSocket contract for this pool
        wsPoolContracts.set(poolAddress.toLowerCase(), wsPoolContract);
        
        // Listen to Swap events (handle both standard and extended formats)
        wsPoolContract.on("Swap", (...args) => {
          console.log("Swap event detected!");
          
          // Extract arguments based on length (7 for standard, 9 for extended)
          let sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick;
          if (args.length === 8) { // Standard V3 (7 params + event object)
            [sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick] = args;
          } else if (args.length === 10) { // Extended V3 with protocol fees (9 params + event object)
            [sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick] = args;
            // Ignore protocol fee params
          }
          
          // Get pool data
          const poolData = getPoolData(poolAddress);
          
          // Calculate volume
          const volumeUSD = calculateSwapVolume(amount0, amount1, false);
          updateVolume(poolData, volumeUSD);
          
          // Update price from the event
          const price = (Number(sqrtPriceX96) ** 2) / 2 ** 192;
          const now = Date.now();
          
          poolData.latestPrice = price;
          poolData.lastUpdated = now;
          
          // Add to history
          poolData.history.push({
            price,
            timestamp: now
          });
          
          // Update OHLC data
          updateOHLCData(poolData, price, now);
          
          console.log(`Pool ${poolAddress}: Price: ${price}, Volume: $${volumeUSD.toFixed(2)}, Total Volume (24h): $${poolData.volume["24h"].toFixed(2)}`);
        });
        
        console.log("WebSocket event listeners set up successfully");
      } catch (wsError) {
        console.error("WebSocket connection failed:", wsError.message);
        console.log("Will use periodic event querying instead");
      }
    } else {
      console.log("WebSocket disabled, using periodic event querying");
    }
    
    // Set up periodic event querying for this pool
    setInterval(() => queryPastEvents(poolAddress), 10000); // Query every 10 seconds
    
    // Initial query
    await queryPastEvents(poolAddress);
  } catch (error) {
    console.error("Error setting up event listeners:", error);
  }
};

// Removed default pool event listeners - pools are initialized on demand

// Get interval prices data with consistent limits
const getIntervalPrices = (poolData, minutes, intervalKey = null) => {
  const now = Date.now();
  const cutoffTime = now - (minutes * 60 * 1000);
  
  // Use the standard limit for the interval
  const limit = intervalKey && DATAPOINT_LIMITS[intervalKey] ? DATAPOINT_LIMITS[intervalKey] : 100;

  // Filter price history to the specified interval
  let filteredData = poolData.history
    .filter(item => item.timestamp >= cutoffTime)
    .map(item => ({
      price: item.price,
      timestamp: item.timestamp
    }));

  // For longer intervals (1w, 1M), if no data in time window, use all available data
  if (filteredData.length === 0 && (minutes >= 10080)) { // 1w = 10080 minutes
    filteredData = poolData.history
      .map(item => ({
        price: item.price,
        timestamp: item.timestamp
      }));
  }

  // If we have more data points than the limit, sample them
  if (filteredData.length > limit) {
    const result = [];
    const step = Math.floor(filteredData.length / limit);

    // Take evenly distributed samples
    for (let i = 0; i < limit - 1; i++) {
      result.push(filteredData[i * step]);
    }

    // Always include the most recent data point
    result.push(filteredData[filteredData.length - 1]);

    return result;
  }

  return filteredData;
};

// Clean up old price history to prevent memory issues
const cleanupOldData = (poolData) => {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000 + 60 * 1000); // 24 hours + 1 minute buffer
  poolData.history = poolData.history.filter(item => item.timestamp >= oneDayAgo);

  // Cleanup old OHLC data as well
  // For 24h candles, keep last 30 days worth
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  poolData.ohlc["24h"] = poolData.ohlc["24h"].filter(candle => candle.timestamp >= thirtyDaysAgo);

  // For 1h candles, keep last 7 days worth
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  poolData.ohlc["1h"] = poolData.ohlc["1h"].filter(candle => candle.timestamp >= sevenDaysAgo);

  // For 1w candles, keep last 2 years worth
  const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
  poolData.ohlc["1w"] = poolData.ohlc["1w"].filter(candle => candle.timestamp >= twoYearsAgo);

  // For 1M candles, keep last 10 years worth
  const tenYearsAgo = Date.now() - (10 * 365 * 24 * 60 * 60 * 1000);
  poolData.ohlc["1M"] = poolData.ohlc["1M"].filter(candle => candle.timestamp >= tenYearsAgo);

  // For other timeframes, we already limit by count in updateOHLCData
};

// Save price data to file
const saveDataToFile = async () => {
  try {
    // Validate and fix OHLC continuity before saving
    for (const [poolAddress, poolData] of poolsData.entries()) {
      validateAndFixOHLCContinuity(poolData);
    }
    
    // Save all pools data
    const allPoolsData = {};
    
    for (const [poolAddress, poolData] of poolsData) {
      allPoolsData[poolAddress] = {
        ...poolData,
        // Don't save volume history for now as it's global
      };
    }
    
    const dataToSave = {
      // Save pools data
      pools: allPoolsData,
      // Save global volume history (limit to last 1000 entries)
      volumeHistory: volumeHistory.slice(-1000),
      // Metadata
      version: 2,
      lastSaved: Date.now()
    };
    
    await fs.writeJson(dataFilePath, dataToSave);
  } catch (error) {
    console.error("Error saving data to file:", error);
  }
};

// Process OHLC data for each interval
const updateOHLCData = (poolData, price, timestamp) => {
  const intervals = {
    "1m": 1 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    "1M": 30 * 24 * 60 * 60 * 1000
  };

  Object.entries(intervals).forEach(([interval, ms]) => {
    const currentOHLC = poolData.ohlc[interval];

    // If no candles exist or the last candle is complete, create a new one
    if (currentOHLC.length === 0 ||
        timestamp >= currentOHLC[currentOHLC.length - 1].timestamp + ms) {

      // Calculate the candle start time (rounded down to interval boundary)
      const roundedTimestamp = Math.floor(timestamp / ms) * ms;

      // For continuity: new candle's open should equal previous candle's close
      const openPrice = currentOHLC.length > 0 ? currentOHLC[currentOHLC.length - 1].close : price;

      currentOHLC.push({
        timestamp: roundedTimestamp,
        open: openPrice,
        high: price,
        low: price,
        close: price
      });
    } else {
      // Update the current candle
      const currentCandle = currentOHLC[currentOHLC.length - 1];
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
    }

    // Limit the number of candles using standard limits
    if (currentOHLC.length > DATAPOINT_LIMITS[interval]) {
      poolData.ohlc[interval] = currentOHLC.slice(-DATAPOINT_LIMITS[interval]);
    }
  });
};

// Track individual swaps for accurate volume calculation
const volumeHistory = [];

// Update volume tracking from actual swap events
const updateVolume = (poolData, volumeInUSD) => {
  const now = Date.now();
  
  // Add to volume history
  volumeHistory.push({
    volume: volumeInUSD,
    timestamp: now
  });
  
  // Add to total volume
  poolData.volume.total += volumeInUSD;
  
  // Calculate volume for each period based on actual history
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  
  // Recalculate volumes based on history
  poolData.volume["24h"] = volumeHistory
    .filter(v => v.timestamp >= dayAgo)
    .reduce((sum, v) => sum + v.volume, 0);
    
  poolData.volume["7d"] = volumeHistory
    .filter(v => v.timestamp >= weekAgo)
    .reduce((sum, v) => sum + v.volume, 0);
    
  poolData.volume["30d"] = volumeHistory
    .filter(v => v.timestamp >= monthAgo)
    .reduce((sum, v) => sum + v.volume, 0);
  
  // Clean up old volume history (keep 30 days)
  const cutoffTime = monthAgo;
  while (volumeHistory.length > 0 && volumeHistory[0].timestamp < cutoffTime) {
    volumeHistory.shift();
  }
};

// Calculate USD volume from swap amounts
const calculateSwapVolume = (amount0, amount1, token0IsUSD) => {
  // For simplicity, we'll assume one token is USD-based
  // In production, you'd need to fetch both token prices
  const amount0Num = Math.abs(Number(amount0));
  const amount1Num = Math.abs(Number(amount1));
  
  if (token0IsUSD) {
    // Token0 is the USD token, use amount0 directly
    return amount0Num / 1e18; // Assuming 18 decimals
  } else {
    // Token1 is the USD token, use amount1 directly
    return amount1Num / 1e18; // Assuming 18 decimals
  }
};

// Main price update function for a specific pool
const updatePrice = async (poolAddress) => {
  const price = await fetchLatestPrice(poolAddress);
  const poolData = getPoolData(poolAddress);

  if (price !== null) {
    const now = Date.now();
    poolData.latestPrice = price;
    poolData.lastUpdated = now;

    // Add to history
    poolData.history.push({
      price,
      timestamp: now
    });

    // Update OHLC data
    updateOHLCData(poolData, price, now);
    
    // Clean up old data
    cleanupOldData(poolData);

    // Save to file (every minute to avoid excessive disk writes)
    if (now % (60 * 1000) < 1000) {
      await saveDataToFile();
    }

    console.log("Updated price:", price);
  } else {
    console.log("Failed to fetch the latest price");
  }
};

// Helper function to validate and map interval parameter
const mapInterval = (interval) => {
  if (interval === "1" || interval === "1m") return "1m";
  else if (interval === "5" || interval === "5m") return "5m";
  else if (interval === "15" || interval === "15m") return "15m";
  else if (interval === "30" || interval === "30m") return "30m";
  else if (interval === "60" || interval === "1h" || interval === "1hour") return "1h";
  else if (interval === "360" || interval === "6" || interval === "6h") return "6h";
  else if (interval === "720" || interval === "12" || interval === "12h") return "12h";
  else if (interval === "1440" || interval === "24" || interval === "24h") return "24h";
  else if (interval === "1w" || interval === "week") return "1w";
  else if (interval === "1M" || interval === "month") return "1M";
  return null;
};

// Helper function to filter OHLC data by timestamp range
const filterOHLCByTimeRange = (ohlcData, fromTimestamp, toTimestamp) => {
  if (!ohlcData || ohlcData.length === 0) return [];
  
  return ohlcData.filter(candle => {
    const candleTime = candle.timestamp;
    const afterFrom = !fromTimestamp || candleTime >= fromTimestamp;
    const beforeTo = !toTimestamp || candleTime <= toTimestamp;
    return afterFrom && beforeTo;
  });
};

// Helper function to limit datapoints consistently
const limitDatapoints = (data, intervalKey) => {
  if (!data || data.length === 0) return data;
  
  const limit = DATAPOINT_LIMITS[intervalKey] || 100;
  
  if (data.length <= limit) {
    return data;
  }
  
  // Take the most recent datapoints up to the limit
  return data.slice(-limit);
};


// API Endpoints
app.get("/api/price", parsePoolAddress, (req, res) => {
  const poolData = getPoolData(req.poolAddress);
  
  res.json({
    pool: req.poolAddress,
    latest: poolData.latestPrice,
    lastUpdated: poolData.lastUpdated
  });
});

// Test endpoint for fetchTokenPriceStats
app.get("/api/test/price-stats", async (req, res) => {
  try {
    const stats = await fetchTokenPriceStats();
    res.json({
      success: true,
      data: stats,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: Date.now()
    });
  }
});

// Debug endpoint to check pool data
app.get("/api/debug/pool", parsePoolAddress, (req, res) => {
  const poolData = getPoolData(req.poolAddress);
  
  res.json({
    pool: req.poolAddress,
    normalizedPool: req.normalizedPoolAddress,
    hasData: poolsData.has(req.normalizedPoolAddress),
    latestPrice: poolData.latestPrice,
    historyLength: poolData.history ? poolData.history.length : 0,
    ohlcKeys: Object.keys(poolData.ohlc || {}),
    ohlcDataLengths: Object.entries(poolData.ohlc || {}).reduce((acc, [key, value]) => {
      acc[key] = Array.isArray(value) ? value.length : 0;
      return acc;
    }, {}),
    volume: poolData.volume,
    lastUpdated: poolData.lastUpdated,
    allPoolKeys: Array.from(poolsData.keys())
  });
});

app.get("/api/price/latest", parsePoolAddress, (req, res) => {
  const poolData = getPoolData(req.poolAddress);
  
  res.json({
    pool: req.poolAddress,
    latest: poolData.latestPrice,
    lastUpdated: poolData.lastUpdated
  });
});

// New time-based query endpoint
app.get("/api/price/query", parsePoolAddress, (req, res) => {
  const { from_timestamp, to_timestamp, interval } = req.query;
  const poolData = getPoolData(req.poolAddress);
  
  // Validate required parameters
  if (!interval) {
    return res.status(400).json({
      error: "Missing required parameter: interval",
      validIntervals: ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Map and validate interval
  const intervalKey = mapInterval(interval);
  if (!intervalKey) {
    return res.status(400).json({
      error: "Invalid interval parameter",
      provided: interval,
      validIntervals: ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Parse timestamps
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  // Validate timestamp range
  if (fromTimestamp && toTimestamp && fromTimestamp > toTimestamp) {
    return res.status(400).json({
      error: "from_timestamp cannot be greater than to_timestamp"
    });
  }
  
  // Get OHLC data for the interval
  const ohlcData = poolData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range
  const filteredData = filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp);
  
  // Apply consistent datapoint limiting
  const limitedData = limitDatapoints(filteredData, intervalKey);
  
  res.json({
    interval: intervalKey,
    from_timestamp: fromTimestamp,
    to_timestamp: toTimestamp,
    count: limitedData.length,
    ohlc: limitedData,
    lastUpdated: poolData.lastUpdated
  });
});

// OHLC endpoint with query parameters for interval and time filtering
app.get("/api/price/ohlc", parsePoolAddress, (req, res) => {
  const { interval, from_timestamp, to_timestamp } = req.query;
  const poolData = getPoolData(req.poolAddress);
  
  // Validate required parameters
  if (!interval) {
    return res.status(400).json({
      error: "Missing required parameter: interval",
      validIntervals: ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Map and validate interval
  const intervalKey = mapInterval(interval);
  if (!intervalKey) {
    return res.status(400).json({
      error: "Invalid interval parameter",
      provided: interval,
      validIntervals: ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Parse timestamps
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  // Validate timestamp range
  if (fromTimestamp && toTimestamp && fromTimestamp > toTimestamp) {
    return res.status(400).json({
      error: "from_timestamp cannot be greater than to_timestamp"
    });
  }
  
  // Get OHLC data for the interval
  const ohlcData = poolData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range
  const filteredData = filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp);
  
  // Apply consistent datapoint limiting
  const limitedData = limitDatapoints(filteredData, intervalKey);
  
  res.json({
    interval: intervalKey,
    from_timestamp: fromTimestamp,
    to_timestamp: toTimestamp,
    count: limitedData.length,
    ohlc: limitedData,
    lastUpdated: poolData.lastUpdated
  });
});

// Add a dedicated endpoint to get all OHLC data
app.get("/api/price/ohlc/all", parsePoolAddress, (req, res) => {
  const poolData = getPoolData(req.poolAddress);
  
  res.json({
    pool: req.poolAddress,
    ohlc: poolData.ohlc,
    lastUpdated: poolData.lastUpdated
  });
});

// Enhanced OHLC endpoint with optional time filtering
app.get("/api/price/ohlc/:interval", parsePoolAddress, (req, res) => {
  const interval = req.params.interval;
  const { from_timestamp, to_timestamp } = req.query;
  const poolData = getPoolData(req.poolAddress);
  
  const intervalKey = mapInterval(interval);
  
  if (!intervalKey) {
    return res.status(400).json({
      error: "Invalid interval parameter",
      provided: interval,
      validIntervals: ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Parse timestamps if provided
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  const ohlcData = poolData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range if timestamps are provided
  const filteredData = (fromTimestamp || toTimestamp) ? 
    filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp) : 
    ohlcData;

  // Apply consistent datapoint limiting
  const limitedData = limitDatapoints(filteredData, intervalKey);

  if (limitedData.length > 0) {
    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      count: limitedData.length,
      ohlc: limitedData,
      lastUpdated: poolData.lastUpdated
    });
  } else {
    res.status(404).json({
      error: "No data available for the specified interval and time range",
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp
    });
  }
});

// Legacy endpoint for backward compatibility
app.get("/api/price/:interval", parsePoolAddress, (req, res) => {
  const interval = req.params.interval;
  const { from_timestamp, to_timestamp } = req.query;
  const poolData = getPoolData(req.poolAddress);
  
  const intervalKey = mapInterval(interval);

  if (!intervalKey) {
    return res.status(400).json({ 
      error: "Invalid interval. Use 1m, 5m, 15m, 30m, 1h, 6h, 12h, 24h, 1w, or 1M" 
    });
  }

  // Parse timestamps if provided
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }

  // Use OHLC data if available, otherwise fall back to the old method
  if (poolData.ohlc[intervalKey] && poolData.ohlc[intervalKey].length > 0) {
    const ohlcData = poolData.ohlc[intervalKey];
    
    // Filter data by timestamp range if timestamps are provided
    const filteredData = (fromTimestamp || toTimestamp) ? 
      filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp) : 
      ohlcData;
    
    // Apply consistent datapoint limiting
    const limitedData = limitDatapoints(filteredData, intervalKey);
    
    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      count: limitedData.length,
      ohlc: limitedData,
      lastUpdated: poolData.lastUpdated
    });
  } else {
    // Fall back to legacy data method
    let minutes = intervalKey === "1m" ? 1 :
                intervalKey === "24h" ? 1440 :
                intervalKey === "1h" ? 60 :
                intervalKey === "6h" ? 360 :
                intervalKey === "12h" ? 720 :
                intervalKey === "1w" ? 10080 :
                intervalKey === "1M" ? 43200 :
                parseInt(intervalKey);

    const intervalData = getIntervalPrices(poolData, minutes, intervalKey);
    
    // Filter legacy data by timestamp if provided
    let filteredData = intervalData;
    if (fromTimestamp || toTimestamp) {
      filteredData = intervalData.filter(item => {
        const afterFrom = !fromTimestamp || item.timestamp >= fromTimestamp;
        const beforeTo = !toTimestamp || item.timestamp <= toTimestamp;
        return afterFrom && beforeTo;
      });
    }

    // Calculate simple stats
    let avg = 0;
    let min = filteredData.length > 0 ? filteredData[0].price : 0;
    let max = 0;

    if (filteredData.length > 0) {
      const sum = filteredData.reduce((acc, item) => acc + item.price, 0);
      avg = sum / filteredData.length;

      filteredData.forEach(item => {
        if (item.price < min) min = item.price;
        if (item.price > max) max = item.price;
      });
    }

    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      dataPoints: filteredData,
      stats: {
        count: filteredData.length,
        avg,
        min,
        max
      },
      lastUpdated: poolData.lastUpdated
    });
  }
});

// Define fixed-path routes before parameter routes
app.get("/api/price/all", parsePoolAddress, (req, res) => {
  const poolData = getPoolData(req.poolAddress);
  const intervalKeys = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (poolData.ohlc[intervalKey] && poolData.ohlc[intervalKey].length > 0) {
      // Use OHLC data with consistent limiting
      result[intervalKey] = limitDatapoints(poolData.ohlc[intervalKey], intervalKey);
    } else {
      // Fall back to legacy method
      const minutes = intervalKey === "1m" ? 1 :
                      intervalKey === "24h" ? 1440 :
                      intervalKey === "1h" ? 60 :
                      intervalKey === "6h" ? 360 :
                      intervalKey === "12h" ? 720 :
                      intervalKey === "1w" ? 10080 :
                      intervalKey === "1M" ? 43200 :
                      parseInt(intervalKey);
      result[intervalKey] = getIntervalPrices(poolData, minutes, intervalKey);
    }
  });

  res.json({
    intervals: result,
    lastUpdated: poolData.lastUpdated
  });
});

app.get("/api/price/intervals/all", parsePoolAddress, (req, res) => {
  const poolData = getPoolData(req.poolAddress);
  const intervalKeys = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (poolData.ohlc[intervalKey] && poolData.ohlc[intervalKey].length > 0) {
      // Use OHLC data with consistent limiting
      result[intervalKey] = limitDatapoints(poolData.ohlc[intervalKey], intervalKey);
    } else {
      // Fall back to legacy method
      const minutes = intervalKey === "1m" ? 1 :
                      intervalKey === "24h" ? 1440 :
                      intervalKey === "1h" ? 60 :
                      intervalKey === "6h" ? 360 :
                      intervalKey === "12h" ? 720 :
                      intervalKey === "1w" ? 10080 :
                      intervalKey === "1M" ? 43200 :
                      parseInt(intervalKey);
      result[intervalKey] = getIntervalPrices(poolData, minutes, intervalKey);
    }
  });

  res.json({
    intervals: result,
    lastUpdated: poolData.lastUpdated
  });
});

// Volume endpoint to get volume data
app.get("/api/volume", parsePoolAddress, (req, res) => {
  const poolData = getPoolData(req.poolAddress);
  
  res.json({
    pool: req.poolAddress,
    volume: poolData.volume,
    lastUpdated: poolData.lastUpdated
  });
});

// Stats endpoint to calculate price percentage changes
app.get("/api/stats", parsePoolAddress, (req, res) => {
  const { interval } = req.query;
  const poolData = getPoolData(req.poolAddress);
  
  if (!interval) {
    return res.status(400).json({
      error: "Missing required parameter: interval",
      validIntervals: ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "7d", "14d", "30d"]
    });
  }
  
  // Map common interval formats
  const intervalMap = {
    "1m": { ms: 1 * 60 * 1000, ohlcKey: "1m" },
    "5m": { ms: 5 * 60 * 1000, ohlcKey: "5m" },
    "15m": { ms: 15 * 60 * 1000, ohlcKey: "15m" },
    "30m": { ms: 30 * 60 * 1000, ohlcKey: "30m" },
    "1h": { ms: 60 * 60 * 1000, ohlcKey: "1h" },
    "6h": { ms: 6 * 60 * 60 * 1000, ohlcKey: "6h" },
    "12h": { ms: 12 * 60 * 60 * 1000, ohlcKey: "12h" },
    "24h": { ms: 24 * 60 * 60 * 1000, ohlcKey: "24h" },
    "7d": { ms: 7 * 24 * 60 * 60 * 1000, ohlcKey: "1w" },
    "14d": { ms: 14 * 24 * 60 * 60 * 1000, ohlcKey: null },
    "30d": { ms: 30 * 24 * 60 * 60 * 1000, ohlcKey: "1M" }
  };
  
  const intervalConfig = intervalMap[interval];
  if (!intervalConfig) {
    return res.status(400).json({
      error: "Invalid interval parameter",
      provided: interval,
      validIntervals: Object.keys(intervalMap)
    });
  }
  
  const now = Date.now();
  const cutoffTime = now - intervalConfig.ms;
  
  // Get current price
  const currentPrice = poolData.latestPrice;
  if (!currentPrice) {
    const isInitializing = poolsInitializing.has(req.normalizedPoolAddress);
    return res.status(503).json({
      error: "Current price not available",
      message: isInitializing 
        ? "Pool is being initialized. Please try again in a few seconds." 
        : "No price data available for this pool yet.",
      pool: req.poolAddress,
      status: isInitializing ? "initializing" : "no_data"
    });
  }
  
  // Try to get the price from the beginning of the interval
  let startPrice = null;
  
  // First, try using OHLC data if available
  if (intervalConfig.ohlcKey && poolData.ohlc[intervalConfig.ohlcKey]) {
    const ohlcData = poolData.ohlc[intervalConfig.ohlcKey];
    // Find the candle that contains our cutoff time
    let closestCandle = null;
    let closestTimeDiff = Infinity;
    
    for (const candle of ohlcData) {
      // Check if the cutoff time falls within this candle's time range
      if (cutoffTime >= candle.timestamp && cutoffTime < candle.timestamp + intervalConfig.ms) {
        // Use the open price of this candle as it represents the price at the start of the period
        startPrice = candle.open;
        break;
      }
      
      // Also track the closest candle in case we don't find an exact match
      const timeDiff = Math.abs(candle.timestamp - cutoffTime);
      if (timeDiff < closestTimeDiff) {
        closestTimeDiff = timeDiff;
        closestCandle = candle;
      }
    }
    
    // If we didn't find an exact match, use the closest candle if it's reasonably close
    if (!startPrice && closestCandle && closestTimeDiff <= intervalConfig.ms) {
      startPrice = closestCandle.close;
    }
  }
  
  // If no OHLC data, fall back to historical data
  if (!startPrice && poolData.history && poolData.history.length > 0) {
    // Find the price closest to the cutoff time
    let closestPrice = null;
    let closestTimeDiff = Infinity;
    
    for (const item of poolData.history) {
      const timeDiff = Math.abs(item.timestamp - cutoffTime);
      if (timeDiff < closestTimeDiff) {
        closestTimeDiff = timeDiff;
        closestPrice = item.price;
      }
    }
    
    // Only use the price if it's within a reasonable range of our target time
    // (within 10% of the interval duration)
    if (closestTimeDiff <= intervalConfig.ms * 0.1) {
      startPrice = closestPrice;
    }
  }
  
  if (!startPrice) {
    return res.status(404).json({
      error: `No historical data available for ${interval} interval`,
      interval: interval,
      currentPrice: currentPrice,
      message: "Unable to calculate percentage change"
    });
  }
  
  // Calculate percentage change
  const priceChange = currentPrice - startPrice;
  const percentageChange = (priceChange / startPrice) * 100;
  
  // Get appropriate volume based on interval
  let volumeForInterval = 0;
  if (interval === "24h" || interval === "1d") {
    volumeForInterval = poolData.volume["24h"];
  } else if (interval === "7d") {
    volumeForInterval = poolData.volume["7d"];
  } else if (interval === "30d") {
    volumeForInterval = poolData.volume["30d"];
  } else {
    // For shorter intervals, estimate based on 24h volume
    const hoursInInterval = intervalConfig.ms / (60 * 60 * 1000);
    volumeForInterval = (poolData.volume["24h"] / 24) * hoursInInterval;
  }
  
  res.json({
    interval: interval,
    currentPrice: currentPrice,
    startPrice: startPrice,
    priceChange: priceChange,
    percentageChange: percentageChange,
    percentageChangeFormatted: `${percentageChange >= 0 ? '+' : ''}${percentageChange.toFixed(2)}%`,
    volume: {
      interval: volumeForInterval,
      "24h": poolData.volume["24h"],
      "7d": poolData.volume["7d"],
      "30d": poolData.volume["30d"],
      total: poolData.volume.total
    },
    timestamp: now,
    lastUpdated: poolData.lastUpdated
  });
});

// Initialize and start the app
const init = async () => {
  try {
    console.log("Starting initialization...");
    
    // Initialize data file
    await initializeDataFile();
    console.log("Data file initialized");
    
    // Set up providers
    console.log(`Setting up provider with URL: ${providerUrl}`);
    provider = new JsonRpcProvider(providerUrl);
    console.log("Provider initialized");
    
    // Initialize monitoring for existing pools
    if (poolsData.size > 0) {
      console.log(`Initializing monitoring for ${poolsData.size} existing pools...`);
      for (const [poolAddress, poolData] of poolsData.entries()) {
        console.log(`Starting monitoring for pool: ${poolAddress}`);
        await initializePool(poolAddress);
      }
    } else {
      console.log("No existing pools to monitor");
    }
    
    // Start API server
    const server = app.listen(PORT, () => {
      console.log(`Price API server running on port ${PORT}`);
      console.log("Server is ready to accept connections");
    });
    
    // Add error handler for server
    server.on('error', (error) => {
      console.error('Server error:', error);
      process.exit(1);
    });
    
    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('\nShutting down server...');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error("Fatal initialization error:", error);
    process.exit(1);
  }
};

init().catch(error => {
  console.error("Initialization error:", error);
  process.exit(1);
});
