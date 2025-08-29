import { ethers, Contract, JsonRpcProvider, WebSocketProvider } from "ethers";
import express from "express";
import cors from "cors";
import fs from "fs-extra";
import IUniswapV3PoolABI from "./artifacts/IUniswapV3PoolAbi.json" assert { type: "json" };

// Configuration
const providerUrl = "https://rpc.ankr.com/monad_testnet";
const wsProviderUrl = "wss://monad-testnet.rpc.ankr.com/ws"; // WebSocket URL for events (may not be available)
const poolAddress = "0x222705B830a38654B46340A99F5F3f1718A5C95d";
const dataFilePath = "./priceData.json";
const PORT = 3001;
const USE_WEBSOCKET = false; // Disable WebSocket for now as Monad testnet may not support it

// Global providers
let provider;
let wsProvider;
let poolContract;
let wsPoolContract;

// Initialize price data storage
const priceData = {
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
};

// Initialize express app
const app = express();
app.use(cors()); // Enable CORS for all routes
app.use(express.json());

// Backfill historical OHLC data from existing price history
const backfillHistoricalOHLC = () => {
  if (priceData.history.length === 0) return;

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
    if (priceData.ohlc[interval] && priceData.ohlc[interval].length >= 2) {
      return; // Skip if we already have sufficient data
    }

    // Clear existing data for clean backfill
    priceData.ohlc[interval] = [];

    // Process each historical price point
    priceData.history.forEach(historyItem => {
      const { price, timestamp } = historyItem;
      const currentOHLC = priceData.ohlc[interval];

      // Calculate the candle start time (rounded down to interval boundary)
      const roundedTimestamp = Math.floor(timestamp / ms) * ms;

      // If no candles exist or the last candle is for a different time period, create a new one
      if (currentOHLC.length === 0 || 
          currentOHLC[currentOHLC.length - 1].timestamp !== roundedTimestamp) {
        
        currentOHLC.push({
          timestamp: roundedTimestamp,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 1
        });
      } else {
        // Update the current candle
        const currentCandle = currentOHLC[currentOHLC.length - 1];
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low = Math.min(currentCandle.low, price);
        currentCandle.close = price;
        currentCandle.volume += 1;
      }
    });

    console.log(`Backfilled ${priceData.ohlc[interval].length} candles for ${interval} interval`);
  });
};

// Generate longer intervals from shorter interval data
const generateIntervalsFromExisting = () => {
  // Generate 6h from 1h data
  if (priceData.ohlc["1h"] && priceData.ohlc["1h"].length > 0) {
    priceData.ohlc["6h"] = generateLongerInterval(priceData.ohlc["1h"], 6 * 60 * 60 * 1000);
    console.log(`Generated ${priceData.ohlc["6h"].length} 6h candles from 1h data`);
  }
  
  // Generate 12h from 1h data
  if (priceData.ohlc["1h"] && priceData.ohlc["1h"].length > 0) {
    priceData.ohlc["12h"] = generateLongerInterval(priceData.ohlc["1h"], 12 * 60 * 60 * 1000);
    console.log(`Generated ${priceData.ohlc["12h"].length} 12h candles from 1h data`);
  }
  
  // If no 1h data, try generating from 5m data
  else if (priceData.ohlc["5m"] && priceData.ohlc["5m"].length > 0) {
    // First generate 1h from 5m
    priceData.ohlc["1h"] = generateLongerInterval(priceData.ohlc["5m"], 60 * 60 * 1000);
    console.log(`Generated ${priceData.ohlc["1h"].length} 1h candles from 5m data`);
    
    // Then generate 6h and 12h from the new 1h data
    priceData.ohlc["6h"] = generateLongerInterval(priceData.ohlc["1h"], 6 * 60 * 60 * 1000);
    priceData.ohlc["12h"] = generateLongerInterval(priceData.ohlc["1h"], 12 * 60 * 60 * 1000);
    console.log(`Generated ${priceData.ohlc["6h"].length} 6h and ${priceData.ohlc["12h"].length} 12h candles`);
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
        close: candle.close,
        volume: candle.volume
      };
      result.push(targetCandle);
    } else {
      // Update existing candle
      targetCandle.high = Math.max(targetCandle.high, candle.high);
      targetCandle.low = Math.min(targetCandle.low, candle.low);
      targetCandle.close = candle.close; // Last close becomes the period close
      targetCandle.volume += candle.volume;
    }
  });
  
  // Sort by timestamp
  return result.sort((a, b) => a.timestamp - b.timestamp);
};

// Create or load existing data file
const initializeDataFile = async () => {
  try {
    if (await fs.pathExists(dataFilePath)) {
      const data = await fs.readJson(dataFilePath);
      Object.assign(priceData, data);
      
      // Ensure all OHLC intervals exist (for backward compatibility)
      if (!priceData.ohlc["1m"]) priceData.ohlc["1m"] = [];
      if (!priceData.ohlc["6h"]) priceData.ohlc["6h"] = [];
      if (!priceData.ohlc["12h"]) priceData.ohlc["12h"] = [];
      if (!priceData.ohlc["1w"]) priceData.ohlc["1w"] = [];
      if (!priceData.ohlc["1M"]) priceData.ohlc["1M"] = [];
      
      // Initialize volume tracking if not present
      if (!priceData.volume) {
        priceData.volume = {
          "24h": 0,
          "7d": 0,
          "30d": 0,
          total: 0,
          lastReset: Date.now()
        };
      }
      
      // Load volume history if saved
      if (data.volumeHistory) {
        volumeHistory.push(...data.volumeHistory);
        // Recalculate volumes based on history
        const now = Date.now();
        const dayAgo = now - 24 * 60 * 60 * 1000;
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
        
        priceData.volume["24h"] = volumeHistory
          .filter(v => v.timestamp >= dayAgo)
          .reduce((sum, v) => sum + v.volume, 0);
          
        priceData.volume["7d"] = volumeHistory
          .filter(v => v.timestamp >= weekAgo)
          .reduce((sum, v) => sum + v.volume, 0);
          
        priceData.volume["30d"] = volumeHistory
          .filter(v => v.timestamp >= monthAgo)
          .reduce((sum, v) => sum + v.volume, 0);
      }
      
      // Backfill historical OHLC data from price history
      backfillHistoricalOHLC();
      
      // Generate 6h and 12h intervals from existing shorter interval data
      generateIntervalsFromExisting();
      
      console.log("Loaded existing price data");
    } else {
      await fs.writeJson(dataFilePath, priceData);
      console.log("Created new price data file");
    }
  } catch (error) {
    console.error("Error initializing data file:", error);
  }
};

// Fetch the latest price from Uniswap pool
const fetchLatestPrice = async () => {
  try {
    if (!poolContract) {
      return null;
    }
    const slot0 = await poolContract.slot0();
    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = (Number(sqrtPriceX96) ** 2) / 2 ** 192;
    return price;
  } catch (error) { 
    console.error("Error fetching price:", error);
    return null;
  }
};

// Track last processed block to avoid duplicates
let lastProcessedBlock = 0;

// Query past events periodically
const queryPastEvents = async () => {
  try {
    if (!poolContract) return;
    
    const currentBlock = await provider.getBlockNumber();
    
    // First run - start from current block
    if (lastProcessedBlock === 0) {
      lastProcessedBlock = currentBlock - 100; // Start from 100 blocks ago
    }
    
    // Don't query if no new blocks
    if (currentBlock <= lastProcessedBlock) return;
    
    console.log(`Querying events from block ${lastProcessedBlock + 1} to ${currentBlock}`);
    
    // Create event filter for Swap events
    const filter = poolContract.filters.Swap();
    
    // Query events in chunks to avoid timeouts
    const blockRange = currentBlock - lastProcessedBlock;
    const chunkSize = 100;
    
    for (let i = lastProcessedBlock + 1; i <= currentBlock; i += chunkSize) {
      const fromBlock = i;
      const toBlock = Math.min(i + chunkSize - 1, currentBlock);
      
      try {
        const events = await poolContract.queryFilter(filter, fromBlock, toBlock);
        
        for (const event of events) {
          const { sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick } = event.args;
          
          // Calculate volume (assuming token1 is USD - you'd need to verify this)
          const volumeUSD = calculateSwapVolume(amount0, amount1, false);
          updateVolume(volumeUSD);
          
          console.log(`Processed swap event: Volume $${volumeUSD.toFixed(2)}`);
        }
      } catch (error) {
        console.error(`Error querying events for blocks ${fromBlock}-${toBlock}:`, error.message);
      }
    }
    
    lastProcessedBlock = currentBlock;
  } catch (error) {
    console.error("Error querying past events:", error);
  }
};

// Set up event listeners for swap events
const setupEventListeners = async () => {
  try {
    if (USE_WEBSOCKET) {
      // Try WebSocket connection if enabled
      try {
        wsProvider = new WebSocketProvider(wsProviderUrl);
        wsPoolContract = new Contract(poolAddress, IUniswapV3PoolABI.abi, wsProvider);
        
        // Get token addresses to determine which is USD
        const token0 = await wsPoolContract.token0();
        const token1 = await wsPoolContract.token1();
        
        console.log("Token0:", token0);
        console.log("Token1:", token1);
        
        // Listen to Swap events
        wsPoolContract.on("Swap", (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
          console.log("Swap event detected!");
          
          // Calculate volume
          const volumeUSD = calculateSwapVolume(amount0, amount1, false);
          updateVolume(volumeUSD);
          
          // Update price from the event
          const price = (Number(sqrtPriceX96) ** 2) / 2 ** 192;
          const now = Date.now();
          
          priceData.latestPrice = price;
          priceData.lastUpdated = now;
          
          // Add to history
          priceData.history.push({
            price,
            timestamp: now
          });
          
          // Update OHLC data
          updateOHLCData(price, now);
          
          console.log(`Swap: Price: ${price}, Volume: $${volumeUSD.toFixed(2)}, Total Volume (24h): $${priceData.volume["24h"].toFixed(2)}`);
        });
        
        console.log("WebSocket event listeners set up successfully");
      } catch (wsError) {
        console.error("WebSocket connection failed:", wsError.message);
        console.log("Will use periodic event querying instead");
      }
    } else {
      console.log("WebSocket disabled, using periodic event querying");
    }
    
    // Set up periodic event querying (runs whether WebSocket works or not)
    setInterval(queryPastEvents, 10000); // Query every 10 seconds
    
    // Initial query
    await queryPastEvents();
  } catch (error) {
    console.error("Error setting up event listeners:", error);
  }
};

// Get interval prices data
const getIntervalPrices = (minutes, limit = 10) => {
  const now = Date.now();
  const cutoffTime = now - (minutes * 60 * 1000);

  // Filter price history to the specified interval
  let filteredData = priceData.history
    .filter(item => item.timestamp >= cutoffTime)
    .map(item => ({
      price: item.price,
      timestamp: item.timestamp
    }));

  // For longer intervals (1w, 1M), if no data in time window, use all available data
  if (filteredData.length === 0 && (minutes >= 10080)) { // 1w = 10080 minutes
    filteredData = priceData.history
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
const cleanupOldData = () => {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000 + 60 * 1000); // 24 hours + 1 minute buffer
  priceData.history = priceData.history.filter(item => item.timestamp >= oneDayAgo);

  // Cleanup old OHLC data as well
  // For 24h candles, keep last 30 days worth
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  priceData.ohlc["24h"] = priceData.ohlc["24h"].filter(candle => candle.timestamp >= thirtyDaysAgo);

  // For 1h candles, keep last 7 days worth
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  priceData.ohlc["1h"] = priceData.ohlc["1h"].filter(candle => candle.timestamp >= sevenDaysAgo);

  // For 1w candles, keep last 2 years worth
  const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
  priceData.ohlc["1w"] = priceData.ohlc["1w"].filter(candle => candle.timestamp >= twoYearsAgo);

  // For 1M candles, keep last 10 years worth
  const tenYearsAgo = Date.now() - (10 * 365 * 24 * 60 * 60 * 1000);
  priceData.ohlc["1M"] = priceData.ohlc["1M"].filter(candle => candle.timestamp >= tenYearsAgo);

  // For other timeframes, we already limit by count in updateOHLCData
};

// Save price data to file
const saveDataToFile = async () => {
  try {
    // Include volume history in saved data (limit to last 1000 entries)
    const dataToSave = {
      ...priceData,
      volumeHistory: volumeHistory.slice(-1000)
    };
    await fs.writeJson(dataFilePath, dataToSave);
  } catch (error) {
    console.error("Error saving data to file:", error);
  }
};

// Process OHLC data for each interval
const updateOHLCData = (price, timestamp) => {
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
    const currentOHLC = priceData.ohlc[interval];

    // If no candles exist or the last candle is complete, create a new one
    if (currentOHLC.length === 0 ||
        timestamp >= currentOHLC[currentOHLC.length - 1].timestamp + ms) {

      // Calculate the candle start time (rounded down to interval boundary)
      const roundedTimestamp = Math.floor(timestamp / ms) * ms;

      currentOHLC.push({
        timestamp: roundedTimestamp,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1 // Simple count of updates
      });
    } else {
      // Update the current candle
      const currentCandle = currentOHLC[currentOHLC.length - 1];
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
      currentCandle.volume += 1;
    }

    // Limit the number of candles to keep memory usage reasonable
    // Keep approximately 100 candles per timeframe
    const maxCandles = {
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

    if (currentOHLC.length > maxCandles[interval]) {
      priceData.ohlc[interval] = currentOHLC.slice(-maxCandles[interval]);
    }
  });
};

// Track individual swaps for accurate volume calculation
const volumeHistory = [];

// Update volume tracking from actual swap events
const updateVolume = (volumeInUSD) => {
  const now = Date.now();
  
  // Add to volume history
  volumeHistory.push({
    volume: volumeInUSD,
    timestamp: now
  });
  
  // Add to total volume
  priceData.volume.total += volumeInUSD;
  
  // Calculate volume for each period based on actual history
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  
  // Recalculate volumes based on history
  priceData.volume["24h"] = volumeHistory
    .filter(v => v.timestamp >= dayAgo)
    .reduce((sum, v) => sum + v.volume, 0);
    
  priceData.volume["7d"] = volumeHistory
    .filter(v => v.timestamp >= weekAgo)
    .reduce((sum, v) => sum + v.volume, 0);
    
  priceData.volume["30d"] = volumeHistory
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

// Main price update function
const updatePrice = async () => {
  const price = await fetchLatestPrice();

  if (price !== null) {
    const now = Date.now();
    priceData.latestPrice = price;
    priceData.lastUpdated = now;

    // Add to history
    priceData.history.push({
      price,
      timestamp: now
    });

    // Update OHLC data
    updateOHLCData(price, now);
    
    // Clean up old data
    cleanupOldData();

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


// API Endpoints
app.get("/api/price", (req, res) => {
  res.json({
    latest: priceData.latestPrice,
    lastUpdated: priceData.lastUpdated
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

app.get("/api/price/latest", (req, res) => {
  res.json({
    latest: priceData.latestPrice,
    lastUpdated: priceData.lastUpdated
  });
});

// New time-based query endpoint
app.get("/api/price/query", (req, res) => {
  const { from_timestamp, to_timestamp, interval } = req.query;
  
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
  const ohlcData = priceData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range
  const filteredData = filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp);
  
  res.json({
    interval: intervalKey,
    from_timestamp: fromTimestamp,
    to_timestamp: toTimestamp,
    count: filteredData.length,
    ohlc: filteredData,
    lastUpdated: priceData.lastUpdated
  });
});

// OHLC endpoint with query parameters for interval and time filtering
app.get("/api/price/ohlc", (req, res) => {
  const { interval, from_timestamp, to_timestamp } = req.query;
  
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
  const ohlcData = priceData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range
  const filteredData = filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp);
  
  res.json({
    interval: intervalKey,
    from_timestamp: fromTimestamp,
    to_timestamp: toTimestamp,
    count: filteredData.length,
    ohlc: filteredData,
    lastUpdated: priceData.lastUpdated
  });
});

// Add a dedicated endpoint to get all OHLC data
app.get("/api/price/ohlc/all", (req, res) => {
  res.json({
    ohlc: priceData.ohlc,
    lastUpdated: priceData.lastUpdated
  });
});

// Enhanced OHLC endpoint with optional time filtering
app.get("/api/price/ohlc/:interval", (req, res) => {
  const interval = req.params.interval;
  const { from_timestamp, to_timestamp } = req.query;
  
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
  
  const ohlcData = priceData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range if timestamps are provided
  const filteredData = (fromTimestamp || toTimestamp) ? 
    filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp) : 
    ohlcData;

  if (filteredData.length > 0) {
    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      count: filteredData.length,
      ohlc: filteredData,
      lastUpdated: priceData.lastUpdated
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
app.get("/api/price/:interval", (req, res) => {
  const interval = req.params.interval;
  const { from_timestamp, to_timestamp } = req.query;
  
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
  if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
    const ohlcData = priceData.ohlc[intervalKey];
    
    // Filter data by timestamp range if timestamps are provided
    const filteredData = (fromTimestamp || toTimestamp) ? 
      filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp) : 
      ohlcData;
    
    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      count: filteredData.length,
      ohlc: filteredData,
      lastUpdated: priceData.lastUpdated
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

    const intervalData = getIntervalPrices(minutes);
    
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
      lastUpdated: priceData.lastUpdated
    });
  }
});

// Define fixed-path routes before parameter routes
app.get("/api/price/all", (req, res) => {
  const intervalKeys = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
      // Use OHLC data
      result[intervalKey] = priceData.ohlc[intervalKey];
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
      result[intervalKey] = getIntervalPrices(minutes);
    }
  });

  res.json({
    intervals: result,
    lastUpdated: priceData.lastUpdated
  });
});

app.get("/api/price/intervals/all", (req, res) => {
  const intervalKeys = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "24h", "1w", "1M"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
      // Use OHLC data
      result[intervalKey] = priceData.ohlc[intervalKey];
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
      result[intervalKey] = getIntervalPrices(minutes);
    }
  });

  res.json({
    intervals: result,
    lastUpdated: priceData.lastUpdated
  });
});

// Volume endpoint to get volume data
app.get("/api/volume", (req, res) => {
  res.json({
    volume: priceData.volume,
    lastUpdated: priceData.lastUpdated
  });
});

// Stats endpoint to calculate price percentage changes
app.get("/api/stats", (req, res) => {
  const { interval } = req.query;
  
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
  const currentPrice = priceData.latestPrice;
  if (!currentPrice) {
    return res.status(503).json({
      error: "Current price not available"
    });
  }
  
  // Try to get the price from the beginning of the interval
  let startPrice = null;
  
  // First, try using OHLC data if available
  if (intervalConfig.ohlcKey && priceData.ohlc[intervalConfig.ohlcKey]) {
    const ohlcData = priceData.ohlc[intervalConfig.ohlcKey];
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
  if (!startPrice && priceData.history && priceData.history.length > 0) {
    // Find the price closest to the cutoff time
    let closestPrice = null;
    let closestTimeDiff = Infinity;
    
    for (const item of priceData.history) {
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
    volumeForInterval = priceData.volume["24h"];
  } else if (interval === "7d") {
    volumeForInterval = priceData.volume["7d"];
  } else if (interval === "30d") {
    volumeForInterval = priceData.volume["30d"];
  } else {
    // For shorter intervals, estimate based on 24h volume
    const hoursInInterval = intervalConfig.ms / (60 * 60 * 1000);
    volumeForInterval = (priceData.volume["24h"] / 24) * hoursInInterval;
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
      "24h": priceData.volume["24h"],
      "7d": priceData.volume["7d"],
      "30d": priceData.volume["30d"],
      total: priceData.volume.total
    },
    timestamp: now,
    lastUpdated: priceData.lastUpdated
  });
});

// Initialize and start the app
const init = async () => {
  // Initialize data file
  await initializeDataFile();
  
  // Set up providers
  provider = new JsonRpcProvider(providerUrl);
  poolContract = new Contract(poolAddress, IUniswapV3PoolABI.abi, provider);
  
  // Set up event listeners for real-time volume tracking
  await setupEventListeners();
  
  // Start price update interval (still useful for regular price updates if events are missed)
  setInterval(updatePrice, 5000); // Reduced frequency since we also get updates from events
  
  // Start API server
  app.listen(PORT, () => {
    console.log(`Price API server running on port ${PORT}`);
  });
};

init().catch(error => {
  console.error("Initialization error:", error);
});
