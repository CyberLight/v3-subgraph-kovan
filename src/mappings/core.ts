/* eslint-disable prefer-const */
import { Bundle, Pool, Token, Factory, Mint, Burn, Swap, Tick } from '../types/schema'
import { Pool as PoolABI } from '../types/Factory/Pool'
import { BigDecimal, BigInt, ethereum, store, log } from '@graphprotocol/graph-ts'
import {
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Flash as FlashEvent,
  Initialize
} from '../types/templates/Pool/Pool'
import { convertTokenToDecimal, loadTransaction, safeDiv } from '../utils'
import { FACTORY_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI } from '../utils/constants'
import { findEthPerToken, getEthPriceInUSD, getTrackedAmountUSD, sqrtPriceX96ToTokenPrices } from '../utils/pricing'
import {
  updateUniswapDayData,
  updatePoolDayData,
  updateTokenDayData,
  updatePoolHourData,
  updateTokenHourData,
  updatePoolFiveMinuteData,
  updateTickDayData,
  updateTickHourData,
  updateTickFiveMinuteData
} from '../utils/intervalUpdates'
import { createTick, feeTierToTickSpacing } from '../utils/tick'

let Q128 = BigInt.fromString('2').pow(128).toBigDecimal();
let MIN_TICK = -887282;

function q128ToBigDecimal(val: BigInt | null): BigDecimal {
  if (val == null) {
    return ZERO_BD;
  } else {
    return val.toBigDecimal().div(Q128);
  }
}

function updateTickVars(pool: Pool, tickId: i32, event: ethereum.Event, isSwap: boolean): void {
  let poolAddress = event.address
  let tickLookupId = poolAddress
    .toHexString()
    .concat('#')
    .concat(tickId.toString())
  let tick = Tick.load(tickLookupId)

  let bundle = Bundle.load('1')

  if (tick == null) {
    log.warning("pool {}, need to create tick at idx {}", [pool.id, tickId.toString()])
    tick = createTick(tickLookupId, tickId, pool.id, event)
  }
  
  if (isSwap) {
    // not all ticks are initialized so obtaining null is expected behavior

    // find previous tick - must iterate to get an initialized tick
    // TODO: use tickBitmap to optimize
    let prevTickId = tickId;
    let prevTick: Tick | null = null;
    let tickSpacing = feeTierToTickSpacing(pool.feeTier).toI32();

    while (!prevTick && prevTickId >= MIN_TICK) {
      log.warning("could not find tick idx {}", [prevTickId.toString()])

      // increment down to get a previous tick
      prevTickId -= tickSpacing

      prevTick = Tick.load(
        poolAddress
          .toHexString()
          .concat('#')
          .concat(prevTickId.toString())
      )
    }

    if (!prevTick) {
      log.error('Could not find previous tick in pool for event {}', [event.logType]);
    }

    let poolContract = PoolABI.bind(poolAddress)
    let tickResult = poolContract.ticks(tickId)
    log.warning("tick results {} {}", [tickResult.value2.toString(), tickResult.value3.toString()])
    tick.feeGrowthOutside0X128 = tickResult.value2
    tick.feeGrowthOutside1X128 = tickResult.value3

    let feeDivisor = pool.feeTier.toBigDecimal().div(BigDecimal.fromString('1000000'));
    // log.warning("pool {}: fee tier {}, divisor: {}", [pool.id, pool.feeTier.toString(), feeDivisor.toString()])

    if (feeDivisor.gt(ZERO_BD)) {
      // calculate fee growth below
      let feeGrowthBelow0X128: BigInt
      let feeGrowthBelow1X128: BigInt
      let tickCurrentId = pool.tick
      
      if (!prevTick) {
        feeGrowthBelow0X128 = pool.feeGrowthGlobal0X128
        feeGrowthBelow1X128 = pool.feeGrowthGlobal1X128
      } else if (tickCurrentId >= prevTick.tickIdx) {
        feeGrowthBelow0X128 = prevTick.feeGrowthOutside0X128;
        feeGrowthBelow1X128 = prevTick.feeGrowthOutside1X128;
      } else {
        feeGrowthBelow0X128 = pool.feeGrowthGlobal0X128.minus(prevTick.feeGrowthOutside0X128);
        feeGrowthBelow1X128 = pool.feeGrowthGlobal1X128.minus(prevTick.feeGrowthOutside1X128);
      }

      // calculate fee growth above
      let feeGrowthAbove0X128: BigInt;
      let feeGrowthAbove1X128: BigInt;
      if (tickCurrentId < tick.tickIdx) {
        feeGrowthAbove0X128 = tick.feeGrowthOutside0X128;
        feeGrowthAbove1X128 = tick.feeGrowthOutside1X128;
      } else {
        feeGrowthAbove0X128 = pool.feeGrowthGlobal0X128.minus(tick.feeGrowthOutside0X128);
        feeGrowthAbove1X128 = pool.feeGrowthGlobal1X128.minus(tick.feeGrowthOutside1X128);
      }

      let feeGrowthInside0X128 = pool.feeGrowthGlobal0X128
        .minus(feeGrowthBelow0X128)
        .minus(feeGrowthAbove0X128);
      let feeGrowthInside1X128 = pool.feeGrowthGlobal1X128
        .minus(feeGrowthBelow1X128)
        .minus(feeGrowthAbove1X128);

      tick.feesToken0 = q128ToBigDecimal(feeGrowthInside0X128.times(tick.liquidityGross))
      tick.volumeToken0 = tick.feesToken0.div(feeDivisor)
      tick.feesToken1 = q128ToBigDecimal(feeGrowthInside1X128.times(tick.liquidityGross))
      tick.volumeToken1 = tick.feesToken1.div(feeDivisor)

      let feesToken0USD = Token.load(pool.token0).derivedETH.times(bundle.ethPriceUSD).times(tick.feesToken0)
      let feesToken1USD = Token.load(pool.token1).derivedETH.times(bundle.ethPriceUSD).times(tick.feesToken1)
      tick.feesUSD = feesToken0USD.plus(feesToken1USD)
      tick.volumeUSD = tick.feesUSD.div(feeDivisor)

      tick.save()
    } else {
      log.warning("Not getting tick volume for {} at fee tier {}", [pool.id, pool.feeTier.toString()])
    }
  
    let tickDayData = updateTickDayData(tick!, event)
    let tickHourData = updateTickHourData(tick!, event)
    let tickFiveMinuteData = updateTickFiveMinuteData(tick!, event)

    tickDayData.volumeToken0 = tick.volumeToken0.minus(tickDayData.startingVolumeToken0)
    tickDayData.volumeToken1 = tick.volumeToken1.minus(tickDayData.startingVolumeToken1)
    tickDayData.volumeUSD = tick.volumeUSD.minus(tickDayData.startingVolumeUSD)
    tickDayData.feesToken0 = tick.feesToken0.minus(tickDayData.startingFeesToken0)
    tickDayData.feesToken1 = tick.feesToken1.minus(tickDayData.startingFeesToken1)
    tickDayData.feesUSD = tick.feesUSD.minus(tickDayData.startingFeesUSD)

    tickHourData.volumeToken0 = tick.volumeToken0.minus(tickHourData.startingVolumeToken0)
    tickHourData.volumeToken1 = tick.volumeToken1.minus(tickHourData.startingVolumeToken1)
    tickHourData.volumeUSD = tick.volumeUSD.minus(tickHourData.startingVolumeUSD)
    tickHourData.feesToken0 = tick.feesToken0.minus(tickHourData.startingFeesToken0)
    tickHourData.feesToken1 = tick.feesToken1.minus(tickHourData.startingFeesToken1)
    tickHourData.feesUSD = tick.feesUSD.minus(tickHourData.startingFeesUSD)

    tickFiveMinuteData.volumeToken0 = tick.volumeToken0.minus(tickFiveMinuteData.startingVolumeToken0)
    tickFiveMinuteData.volumeToken1 = tick.volumeToken1.minus(tickFiveMinuteData.startingVolumeToken1)
    tickFiveMinuteData.volumeUSD = tick.volumeUSD.minus(tickFiveMinuteData.startingVolumeUSD)
    tickFiveMinuteData.feesToken0 = tick.feesToken0.minus(tickFiveMinuteData.startingFeesToken0)
    tickFiveMinuteData.feesToken1 = tick.feesToken1.minus(tickFiveMinuteData.startingFeesToken1)
    tickFiveMinuteData.feesUSD = tick.feesUSD.minus(tickFiveMinuteData.startingFeesUSD)

    tickDayData.save()
    tickHourData.save()
    tickFiveMinuteData.save()
  }
}

export function handleInitialize(event: Initialize): void {
  let pool = Pool.load(event.address.toHexString())
  pool.sqrtPrice = event.params.sqrtPriceX96
  pool.tick = BigInt.fromI32(event.params.tick)
  // update token prices
  let token0 = Token.load(pool.token0)
  let token1 = Token.load(pool.token1)

  // update ETH price now that prices could have changed
  let bundle = Bundle.load('1')
  bundle.ethPriceUSD = getEthPriceInUSD()
  bundle.save()

  updatePoolDayData(event)
  updatePoolHourData(event)
  updatePoolFiveMinuteData(event)

  // update token prices
  token0.derivedETH = findEthPerToken(token0 as Token)
  token1.derivedETH = findEthPerToken(token1 as Token)
  token0.save()
  token1.save()
}

export function handleMint(event: MintEvent): void {
  let bundle = Bundle.load('1')
  let poolAddress = event.address.toHexString()
  let pool = Pool.load(poolAddress)
  let factory = Factory.load(FACTORY_ADDRESS)

  let token0 = Token.load(pool.token0)
  let token1 = Token.load(pool.token1)
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  let amountUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))

  // reset tvl aggregates until new amounts calculated
  factory.totalValueLockedETH = factory.totalValueLockedETH.minus(pool.totalValueLockedETH)

  // update globals
  factory.txCount = factory.txCount.plus(ONE_BI)

  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.totalValueLocked = token0.totalValueLocked.plus(amount0)
  token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedETH.times(bundle.ethPriceUSD))

  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.totalValueLocked = token1.totalValueLocked.plus(amount1)
  token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedETH.times(bundle.ethPriceUSD))

  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)

  // Pools liquidity tracks the currently active liquidity given pools current tick.
  // We only want to update it on mint if the new position includes the current tick.
  if (
    pool.tick !== null &&
    BigInt.fromI32(event.params.tickLower).le(pool.tick as BigInt) &&
    BigInt.fromI32(event.params.tickUpper).gt(pool.tick as BigInt)
  ) {
    pool.liquidity = pool.liquidity.plus(event.params.amount)
  }

  pool.totalValueLockedToken0 = pool.totalValueLockedToken0.plus(amount0)
  pool.totalValueLockedToken1 = pool.totalValueLockedToken1.plus(amount1)
  pool.totalValueLockedETH = pool.totalValueLockedToken0
    .times(token0.derivedETH)
    .plus(pool.totalValueLockedToken1.times(token1.derivedETH))
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)

  // reset aggregates with new amounts
  factory.totalValueLockedETH = factory.totalValueLockedETH.plus(pool.totalValueLockedETH)
  factory.totalValueLockedUSD = factory.totalValueLockedETH.times(bundle.ethPriceUSD)

  let transaction = loadTransaction(event)
  let mint = new Mint(transaction.id.toString() + '#' + pool.txCount.toString())
  mint.transaction = transaction.id
  mint.timestamp = transaction.timestamp
  mint.pool = pool.id
  mint.token0 = pool.token0
  mint.token1 = pool.token1
  mint.owner = event.params.owner
  mint.sender = event.params.sender
  mint.origin = event.transaction.from
  mint.amount = event.params.amount
  mint.amount0 = amount0
  mint.amount1 = amount1
  mint.amountUSD = amountUSD 
  mint.tickLower = BigInt.fromI32(event.params.tickLower)
  mint.tickUpper = BigInt.fromI32(event.params.tickUpper)
  mint.logIndex = event.logIndex

  // tick entities
  let lowerTickIdx = event.params.tickLower
  let upperTickIdx = event.params.tickUpper

  let lowerTickId = poolAddress + '#' + BigInt.fromI32(event.params.tickLower).toString()
  let upperTickId = poolAddress + '#' + BigInt.fromI32(event.params.tickUpper).toString()

  let lowerTick = Tick.load(lowerTickId)
  let upperTick = Tick.load(upperTickId)

  if (lowerTick === null) {
    lowerTick = createTick(lowerTickId, lowerTickIdx, pool.id, event)
  }

  if (upperTick === null) {
    upperTick = createTick(upperTickId, upperTickIdx, pool.id, event)
  }

  let amount = event.params.amount
  lowerTick.liquidityGross = lowerTick.liquidityGross.plus(amount)
  lowerTick.liquidityNet = lowerTick.liquidityNet.plus(amount)
  upperTick.liquidityGross = upperTick.liquidityGross.plus(amount)
  upperTick.liquidityNet = upperTick.liquidityNet.minus(amount)

  // TODO: Update Tick's volume, fees, and liquidity provider count. Computing these on the tick
  // level requires reimplementing some of the swapping code from v3-core.

  updateUniswapDayData(event)
  updatePoolDayData(event)
  updatePoolHourData(event)
  updatePoolFiveMinuteData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
  updateTokenHourData(token0 as Token, event)
  updateTokenHourData(token1 as Token, event)
  // Update inner tick vars
  updateTickVars(pool!, event.params.tickLower, event, false)
  updateTickVars(pool!, event.params.tickUpper, event, false)

  token0.save()
  token1.save()
  pool.save()
  factory.save()
  mint.save()
  lowerTick.save()
  upperTick.save()
}

export function handleBurn(event: BurnEvent): void {
  let bundle = Bundle.load('1')
  let poolAddress = event.address.toHexString()
  let pool = Pool.load(poolAddress)
  let factory = Factory.load(FACTORY_ADDRESS)

  let token0 = Token.load(pool.token0)
  let token1 = Token.load(pool.token1)
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  let amountUSD = amount0
    .times(token0.derivedETH.times(bundle.ethPriceUSD))
    .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)))

  // reset tvl aggregates until new amounts calculated
  factory.totalValueLockedETH = factory.totalValueLockedETH.minus(pool.totalValueLockedETH)

  // update globals
  factory.txCount = factory.txCount.plus(ONE_BI)

  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.totalValueLocked = token0.totalValueLocked.minus(amount0)
  token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedETH.times(bundle.ethPriceUSD))

  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.totalValueLocked = token1.totalValueLocked.minus(amount1)
  token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedETH.times(bundle.ethPriceUSD))

  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)
  // Pools liquidity tracks the currently active liquidity given pools current tick.
  // We only want to update it on burn if the position being burnt includes the current tick.
  if (
    pool.tick !== null &&
    BigInt.fromI32(event.params.tickLower).le(pool.tick as BigInt) &&
    BigInt.fromI32(event.params.tickUpper).gt(pool.tick as BigInt)
  ) {
    pool.liquidity = pool.liquidity.minus(event.params.amount)
  }

  pool.totalValueLockedToken0 = pool.totalValueLockedToken0.minus(amount0)
  pool.totalValueLockedToken1 = pool.totalValueLockedToken1.minus(amount1)
  pool.totalValueLockedETH = pool.totalValueLockedToken0
    .times(token0.derivedETH)
    .plus(pool.totalValueLockedToken1.times(token1.derivedETH))
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)

  // reset aggregates with new amounts
  factory.totalValueLockedETH = factory.totalValueLockedETH.plus(pool.totalValueLockedETH)
  factory.totalValueLockedUSD = factory.totalValueLockedETH.times(bundle.ethPriceUSD)

  // burn entity
  let transaction = loadTransaction(event)
  let burn = new Burn(transaction.id + '#' + pool.txCount.toString())
  burn.transaction = transaction.id
  burn.timestamp = transaction.timestamp
  burn.pool = pool.id
  burn.token0 = pool.token0
  burn.token1 = pool.token1
  burn.owner = event.params.owner
  burn.origin = event.transaction.from
  burn.amount = event.params.amount
  burn.amount0 = amount0
  burn.amount1 = amount1
  burn.amountUSD = amountUSD
  burn.tickLower = BigInt.fromI32(event.params.tickLower)
  burn.tickUpper = BigInt.fromI32(event.params.tickUpper)
  burn.logIndex = event.logIndex

  // tick entities
  let lowerTickId = poolAddress + '#' + BigInt.fromI32(event.params.tickLower).toString()
  let upperTickId = poolAddress + '#' + BigInt.fromI32(event.params.tickUpper).toString()
  let lowerTick = Tick.load(lowerTickId)
  let upperTick = Tick.load(upperTickId)
  let amount = event.params.amount
  lowerTick.liquidityGross = lowerTick.liquidityGross.minus(amount)
  lowerTick.liquidityNet = lowerTick.liquidityNet.minus(amount)
  upperTick.liquidityGross = upperTick.liquidityGross.minus(amount)
  upperTick.liquidityNet = upperTick.liquidityNet.plus(amount)

  updateUniswapDayData(event)
  updatePoolDayData(event)
  updatePoolHourData(event)
  updatePoolFiveMinuteData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
  updateTokenHourData(token0 as Token, event)
  updateTokenHourData(token1 as Token, event)

  updateTickVars(pool!, event.params.tickLower, event, false)
  lowerTick.save()

  updateTickVars(pool!, event.params.tickUpper, event, false)
  upperTick.save()

  token0.save()
  token1.save()
  pool.save()
  factory.save()
  burn.save()
}

export function handleSwap(event: SwapEvent): void {
  let bundle = Bundle.load('1')
  let factory = Factory.load(FACTORY_ADDRESS)
  let pool = Pool.load(event.address.toHexString())

  // hot fix for bad pricing
  if (pool.id == '0x9663f2ca0454accad3e094448ea6f77443880454') {
    return
  }

  let token0 = Token.load(pool.token0)
  let token1 = Token.load(pool.token1)

  let oldTick = pool.tick!

  // amounts - 0/1 are token deltas: can be positive or negative
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // need absolute amounts for volume
  let amount0Abs = amount0
  if (amount0.lt(ZERO_BD)) {
    amount0Abs = amount0.times(BigDecimal.fromString('-1'))
  }
  let amount1Abs = amount1
  if (amount1.lt(ZERO_BD)) {
    amount1Abs = amount1.times(BigDecimal.fromString('-1'))
  }

  let amount0ETH = amount0Abs.times(token0.derivedETH)
  let amount1ETH = amount1Abs.times(token1.derivedETH)
  let amount0USD = amount0ETH.times(bundle.ethPriceUSD)
  let amount1USD = amount1ETH.times(bundle.ethPriceUSD)

  // get amount that should be tracked only - div 2 because cant count both input and output as volume
  let amountTotalUSDTracked = getTrackedAmountUSD(amount0Abs, token0 as Token, amount1Abs, token1 as Token).div(
    BigDecimal.fromString('2')
  )
  let amountTotalETHTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD)
  let amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(BigDecimal.fromString('2'))

  let feesETH = amountTotalETHTracked.times(pool.feeTier.toBigDecimal()).div(BigDecimal.fromString('1000000'))
  let feesUSD = amountTotalUSDTracked.times(pool.feeTier.toBigDecimal()).div(BigDecimal.fromString('1000000'))

  // global updates
  factory.txCount = factory.txCount.plus(ONE_BI)
  factory.totalVolumeETH = factory.totalVolumeETH.plus(amountTotalETHTracked)
  factory.totalVolumeUSD = factory.totalVolumeUSD.plus(amountTotalUSDTracked)
  factory.untrackedVolumeUSD = factory.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  factory.totalFeesETH = factory.totalFeesETH.plus(feesETH)
  factory.totalFeesUSD = factory.totalFeesUSD.plus(feesUSD)

  // reset aggregate tvl before individual pool tvl updates
  let currentPoolTvlETH = pool.totalValueLockedETH
  factory.totalValueLockedETH = factory.totalValueLockedETH.minus(currentPoolTvlETH)

  // pool volume
  pool.volumeToken0 = pool.volumeToken0.plus(amount0Abs)
  pool.volumeToken1 = pool.volumeToken1.plus(amount1Abs)
  pool.volumeUSD = pool.volumeUSD.plus(amountTotalUSDTracked)
  pool.untrackedVolumeUSD = pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  pool.feesUSD = pool.feesUSD.plus(feesUSD)
  pool.txCount = pool.txCount.plus(ONE_BI)

  // Update the pool with the new active liquidity, price, and tick.
  pool.liquidity = event.params.liquidity
  pool.tick = BigInt.fromI32(event.params.tick as i32)
  pool.sqrtPrice = event.params.sqrtPriceX96
  pool.totalValueLockedToken0 = pool.totalValueLockedToken0.plus(amount0)
  pool.totalValueLockedToken1 = pool.totalValueLockedToken1.plus(amount1)

  // update token0 data
  token0.volume = token0.volume.plus(amount0Abs)
  token0.totalValueLocked = token0.totalValueLocked.plus(amount0)
  token0.volumeUSD = token0.volumeUSD.plus(amountTotalUSDTracked)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  token0.feesUSD = token0.feesUSD.plus(feesUSD)
  token0.txCount = token0.txCount.plus(ONE_BI)

  // update token1 data
  token1.volume = token1.volume.plus(amount1Abs)
  token1.totalValueLocked = token1.totalValueLocked.plus(amount1)
  token1.volumeUSD = token1.volumeUSD.plus(amountTotalUSDTracked)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  token1.feesUSD = token1.feesUSD.plus(feesUSD)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // updated pool ratess
  let prices = sqrtPriceX96ToTokenPrices(pool.sqrtPrice, token0 as Token, token1 as Token)
  pool.token0Price = prices[0]
  pool.token1Price = prices[1]
  pool.save()

  // update USD pricing
  bundle.ethPriceUSD = getEthPriceInUSD()
  bundle.save()
  token0.derivedETH = findEthPerToken(token0 as Token)
  token1.derivedETH = findEthPerToken(token1 as Token)

  /**
   * Things afffected by new USD rates
   */
  pool.totalValueLockedETH = pool.totalValueLockedToken0
    .times(token0.derivedETH)
    .plus(pool.totalValueLockedToken1.times(token1.derivedETH))
  pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)

  factory.totalValueLockedETH = factory.totalValueLockedETH.plus(pool.totalValueLockedETH)
  factory.totalValueLockedUSD = factory.totalValueLockedETH.times(bundle.ethPriceUSD)

  token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedETH).times(bundle.ethPriceUSD)
  token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedETH).times(bundle.ethPriceUSD)

  // create Swap event
  let transaction = loadTransaction(event)
  let swap = new Swap(transaction.id + '#' + pool.txCount.toString())
  swap.transaction = transaction.id
  swap.timestamp = transaction.timestamp
  swap.pool = pool.id
  swap.token0 = pool.token0
  swap.token1 = pool.token1
  swap.sender = event.params.sender
  swap.origin = event.transaction.from
  swap.recipient = event.params.recipient
  swap.amount0 = amount0
  swap.amount1 = amount1
  swap.amountUSD = amountTotalUSDTracked
  swap.tick = BigInt.fromI32(event.params.tick as i32)
  swap.sqrtPriceX96 = event.params.sqrtPriceX96
  swap.logIndex = event.logIndex

  // update fee growth
  let poolContract = PoolABI.bind(event.address)
  let feeGrowthGlobal0X128 = poolContract.feeGrowthGlobal0X128()
  let feeGrowthGlobal1X128 = poolContract.feeGrowthGlobal1X128()
  pool.feeGrowthGlobal0X128 = feeGrowthGlobal0X128 as BigInt
  pool.feeGrowthGlobal1X128 = feeGrowthGlobal1X128 as BigInt

  // interval data
  let uniswapDayData = updateUniswapDayData(event)
  let poolDayData = updatePoolDayData(event)
  let poolHourData = updatePoolHourData(event)
  let poolFiveMinuteData = updatePoolFiveMinuteData(event)
  let token0DayData = updateTokenDayData(token0 as Token, event)
  let token1DayData = updateTokenDayData(token1 as Token, event)
  let token0HourData = updateTokenHourData(token0 as Token, event)
  let token1HourData = updateTokenHourData(token1 as Token, event)

  // update volume metrics
  uniswapDayData.volumeETH = uniswapDayData.volumeETH.plus(amountTotalETHTracked)
  uniswapDayData.volumeUSD = uniswapDayData.volumeUSD.plus(amountTotalUSDTracked)
  uniswapDayData.feesUSD = uniswapDayData.feesUSD.plus(feesUSD)

  poolDayData.volumeUSD = poolDayData.volumeUSD.plus(amountTotalUSDTracked)
  poolDayData.volumeToken0 = poolDayData.volumeToken0.plus(amount0Abs)
  poolDayData.volumeToken1 = poolDayData.volumeToken1.plus(amount1Abs)
  poolDayData.feesUSD = poolDayData.feesUSD.plus(feesUSD)

  poolHourData.volumeUSD = poolHourData.volumeUSD.plus(amountTotalUSDTracked)
  poolHourData.volumeToken0 = poolHourData.volumeToken0.plus(amount0Abs)
  poolHourData.volumeToken1 = poolHourData.volumeToken1.plus(amount1Abs)
  poolHourData.feesUSD = poolHourData.feesUSD.plus(feesUSD)

  poolFiveMinuteData.volumeUSD = poolFiveMinuteData.volumeUSD.plus(amountTotalUSDTracked)
  poolFiveMinuteData.volumeToken0 = poolFiveMinuteData.volumeToken0.plus(amount0Abs)
  poolFiveMinuteData.volumeToken1 = poolFiveMinuteData.volumeToken1.plus(amount1Abs)
  poolFiveMinuteData.feesUSD = poolFiveMinuteData.feesUSD.plus(feesUSD)

  token0DayData.volume = token0DayData.volume.plus(amount0Abs)
  token0DayData.volumeUSD = token0DayData.volumeUSD.plus(amountTotalUSDTracked)
  token0DayData.untrackedVolumeUSD = token0DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token0DayData.feesUSD = token0DayData.feesUSD.plus(feesUSD)

  token0HourData.volume = token0HourData.volume.plus(amount0Abs)
  token0HourData.volumeUSD = token0HourData.volumeUSD.plus(amountTotalUSDTracked)
  token0HourData.untrackedVolumeUSD = token0HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token0HourData.feesUSD = token0HourData.feesUSD.plus(feesUSD)

  token1DayData.volume = token1DayData.volume.plus(amount1Abs)
  token1DayData.volumeUSD = token1DayData.volumeUSD.plus(amountTotalUSDTracked)
  token1DayData.untrackedVolumeUSD = token1DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token1DayData.feesUSD = token1DayData.feesUSD.plus(feesUSD)

  token1HourData.volume = token1HourData.volume.plus(amount1Abs)
  token1HourData.volumeUSD = token1HourData.volumeUSD.plus(amountTotalUSDTracked)
  token1HourData.untrackedVolumeUSD = token1HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token1HourData.feesUSD = token1HourData.feesUSD.plus(feesUSD)

  swap.save()
  token0DayData.save()
  token1DayData.save()
  uniswapDayData.save()
  poolDayData.save()
  poolHourData.save()
  poolFiveMinuteData.save()
  factory.save()
  pool.save()
  token0.save()
  token1.save()

  // Update inner vars of current or crossed ticks
  let newTick = pool.tick!
  let tickSpacing = feeTierToTickSpacing(pool.feeTier)
  let modulo = newTick.mod(tickSpacing)
  log.warning("pool {}, Updating tick vars at tick {}", [pool.id, newTick.toString()])
  // Current tick is initialized and needs to be updated
  updateTickVars(pool!, newTick.toI32(), event, true)

  let numIters = oldTick
    .minus(newTick)
    .abs()
    .div(tickSpacing)

  if (numIters.gt(BigInt.fromI32(100))) {
    // In case more than 100 ticks need to be updated ignore the update in
    // order to avoid timeouts. From testing this behavior occurs only upon
    // pool initialization. This should not be a big issue as the ticks get
    // updated later. For early users this error also disappears when calling
    // collect
  } else if (newTick.gt(oldTick)) {
    let firstInitialized = oldTick.plus(tickSpacing.minus(modulo))
    for (let i = firstInitialized; i.le(newTick); i = i.plus(tickSpacing)) {
      log.warning("pool {}, Updating tick vars at tick {}", [pool.id, i.toString()])
      updateTickVars(pool!, i.toI32(), event, true)
    }
  } else if (newTick.lt(oldTick)) {
    let firstInitialized = oldTick.minus(modulo)
    for (let i = firstInitialized; i.ge(newTick); i = i.minus(tickSpacing)) {
      log.warning("pool {}, Updating tick vars at tick {}", [pool.id, i.toString()])
      updateTickVars(pool!, i.toI32(), event, true)
    }
  }
}

export function handleFlash(event: FlashEvent): void {
  // update fee growth
  let pool = Pool.load(event.address.toHexString())
  let poolContract = PoolABI.bind(event.address)
  let feeGrowthGlobal0X128 = poolContract.feeGrowthGlobal0X128()
  let feeGrowthGlobal1X128 = poolContract.feeGrowthGlobal1X128()
  pool.feeGrowthGlobal0X128 = feeGrowthGlobal0X128 as BigInt
  pool.feeGrowthGlobal1X128 = feeGrowthGlobal1X128 as BigInt
  pool.save()
}