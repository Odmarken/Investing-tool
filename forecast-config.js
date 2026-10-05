// Shared constants for AI Forecast: model versions, timeframes, coins and the
// frozen rule and forecast parameters. Every module reads them from here, so a
// stored signal or forecast always names the exact rules that produced it.
import {CONTRACTS} from './bybit-contracts.js';
export const MODEL=Object.freeze({signal:'af-signal-v1',forecast:'af-forecast-v1'});
export const TF=Object.freeze({
  '5m':Object.freeze({key:'5m',ms:300000,bybit:'5',label:'5m',htf:'1h'}),
  '15m':Object.freeze({key:'15m',ms:900000,bybit:'15',label:'15m',htf:'1h'}),
  '1h':Object.freeze({key:'1h',ms:3600000,bybit:'60',label:'1h',htf:'4h'}),
  '4h':Object.freeze({key:'4h',ms:14400000,bybit:'240',label:'4h',htf:'1d'}),
  '1d':Object.freeze({key:'1d',ms:86400000,bybit:'D',label:'1D',htf:'1w'}),
  // Only used as an aggregated higher timeframe for the daily chart.
  '1w':Object.freeze({key:'1w',ms:604800000,bybit:'W',label:'1W',htf:null})
});
export const CHART_TFS=Object.freeze(['5m','15m','1h','4h','1d']);
export const SYMBOLS=Object.freeze(Object.keys(CONTRACTS));
export const SIGNAL_PARAMS=Object.freeze({
  emaFast:20,emaSlow:50,emaWindow:4,slopeBars:10,
  adxPeriod:14,adxWindow:100,adxTrend:22,adxRange:18,
  rsiPeriod:14,rsiWindow:4,rsiLong:Object.freeze([50,75]),rsiShort:Object.freeze([25,50]),
  rocPeriod:10,
  breakout:20,
  volMedian:20,volMin:1.1,
  atrPeriod:14,atrWindow:4,volRankWindow:200,volRankMin:.1,volRankMax:.95,
  slAtr:1.5,tpR:2,
  cooldown:5,maxHold:20,
  htfEma:20,htfWindow:3
});
export const FORECAST_PARAMS=Object.freeze({horizon:20,k:30,train:1500,minCandidates:150,quantiles:Object.freeze([.1,.25,.5,.75,.9])});
