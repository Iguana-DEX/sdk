import { BigNumber, parseFixed } from '@ethersproject/bignumber';
import { AddressZero } from '@ethersproject/constants';
import * as SOR from '@balancer-labs/sor';
import {
  ExitConcern,
  ExitExactBPTInAttributes,
  ExitExactTokensOutAttributes,
  ExitExactBPTInParameters,
  ExitExactTokensOutParameters,
  ExitPool,
  ExitPoolAttributes,
} from '../types';
import { AssetHelpers, isSameAddress, parsePoolInfo } from '@/lib/utils';
import { Vault__factory } from '@/contracts/factories/Vault__factory';
import { addSlippage, subSlippage } from '@/lib/utils/slippageHelper';
import { balancerVault } from '@/lib/constants/config';
import { BalancerError, BalancerErrorCode } from '@/balancerErrors';
import { WeightedPoolEncoder } from '@/pool-weighted';
import {
  _downscaleDown,
  _downscaleDownArray,
  _upscaleArray,
} from '@/lib/utils/solidityMaths';
import { Pool } from '@/types';

interface SortedValues {
  poolTokens: string[];
  weights: bigint[];
  totalSharesEvm: bigint;
  swapFeeEvm: bigint;
  upScaledBalances: bigint[];
}

type ExactBPTInSortedValues = SortedValues & {
  scalingFactors: bigint[];
  singleTokenOutIndex: number;
};

type ExactTokensOutSortedValues = SortedValues & {
  upScaledAmountsOut: bigint[];
  downScaledAmountsOut: string[];
};
type CalcBptInGivenExactTokensOutParams = ExactTokensOutSortedValues &
  Pick<ExitExactTokensOutParameters, 'slippage'>;

type SortValuesParams = {
  pool: Pool;
  wrappedNativeAsset: string;
  shouldUnwrapNativeAsset?: boolean;
};

type SortValuesExactBptInParams = SortValuesParams & {
  singleTokenOut?: string;
};

type SortValuesExactTokensOutParams = SortValuesParams & {
  amountsOut: string[];
  tokensOut: string[];
};

type EncodeExitParams = Pick<ExitExactBPTInParameters, 'exiter'> & {
  poolTokens: string[];
  poolId: string;
  userData: string;
  minAmountsOut: string[];
};

export class WeightedPoolExit implements ExitConcern {
  buildExitExactBPTIn = ({
    exiter,
    pool,
    bptIn,
    slippage,
    shouldUnwrapNativeAsset,
    wrappedNativeAsset,
    singleTokenOut,
  }: ExitExactBPTInParameters): ExitExactBPTInAttributes => {
    this.checkInputsExactBPTIn({
      bptIn,
      singleTokenOut,
      pool,
      shouldUnwrapNativeAsset,
    });
    const sortedValues = this.sortValuesExitExactBptIn({
      pool,
      wrappedNativeAsset,
      shouldUnwrapNativeAsset,
      singleTokenOut,
    });
    const { minAmountsOut, expectedAmountsOut } =
      sortedValues.singleTokenOutIndex >= 0
        ? this.calcTokenOutGivenExactBptIn({
            ...sortedValues,
            bptIn,
            slippage,
          })
        : this.calcTokensOutGivenExactBptIn({
            ...sortedValues,
            bptIn,
            slippage,
          });

    const userData =
      sortedValues.singleTokenOutIndex >= 0
        ? WeightedPoolEncoder.exitExactBPTInForOneTokenOut(
            bptIn,
            sortedValues.singleTokenOutIndex
          )
        : WeightedPoolEncoder.exitExactBPTInForTokensOut(bptIn);

    const encodedData = this.encodeExitPool({
      poolTokens: sortedValues.poolTokens,
      poolId: pool.id,
      exiter,
      minAmountsOut,
      userData,
    });

    return {
      ...encodedData,
      expectedAmountsOut,
      minAmountsOut,
    };
  };

  buildExitExactTokensOut = ({
    exiter,
    pool,
    tokensOut,
    amountsOut,
    slippage,
    wrappedNativeAsset,
  }: ExitExactTokensOutParameters): ExitExactTokensOutAttributes => {
    this.checkInputsExactTokensOut(amountsOut, tokensOut, pool);

    const sortedValues = this.sortValuesExitExactTokensOut({
      pool,
      wrappedNativeAsset,
      amountsOut,
      tokensOut,
    });
    const { expectedBPTIn, maxBPTIn } = this.calcBptInGivenExactTokensOut({
      ...sortedValues,
      slippage,
    });

    const { downScaledAmountsOut, poolTokens } = sortedValues;
    const userData = WeightedPoolEncoder.exitBPTInForExactTokensOut(
      downScaledAmountsOut,
      maxBPTIn
    );
    const encodedData = this.encodeExitPool({
      poolId: pool.id,
      userData,
      poolTokens,
      minAmountsOut: downScaledAmountsOut,
      exiter,
    });

    return {
      ...encodedData,
      expectedBPTIn,
      maxBPTIn,
    };
  };
  /**
   *  Checks if the input of buildExitExactBPTIn is valid
   * @param bptIn Bpt inserted in the transaction
   * @param singleTokenOut (optional) the address of the single token that will be withdrawn, if null|undefined, all tokens will be withdrawn proportionally.
   * @param pool the pool that is being exited
   * @param shouldUnwrapNativeAsset Set true if the weth should be unwrapped to Eth
   */
  checkInputsExactBPTIn = ({
    bptIn,
    singleTokenOut,
    pool,
    shouldUnwrapNativeAsset,
  }: Pick<
    ExitExactBPTInParameters,
    'bptIn' | 'singleTokenOut' | 'pool' | 'shouldUnwrapNativeAsset'
  >): void => {
    if (!bptIn.length || parseFixed(bptIn, 18).isNegative()) {
      throw new BalancerError(BalancerErrorCode.INPUT_OUT_OF_BOUNDS);
    }
    if (
      singleTokenOut &&
      singleTokenOut !== AddressZero &&
      !pool.tokens
        .map((t) => t.address)
        .some((a) => isSameAddress(a, singleTokenOut))
    ) {
      throw new BalancerError(BalancerErrorCode.TOKEN_MISMATCH);
    }

    if (!shouldUnwrapNativeAsset && singleTokenOut === AddressZero)
      throw new Error(
        'shouldUnwrapNativeAsset and singleTokenOut should not have conflicting values'
      );

    // Check if there's any relevant weighted pool info missing
    if (pool.tokens.some((token) => !token.decimals))
      throw new BalancerError(BalancerErrorCode.MISSING_DECIMALS);
  };
  /**
   * Checks if the input of buildExitExactTokensOut is valid
   * @param amountsOut Must have an amount for each token, if the user will not withdraw any amount for a token, the value shall be '0'
   * @param tokensOut Must contain all the tokens of the pool
   * @param pool The pool that is being exited
   */
  checkInputsExactTokensOut = (
    amountsOut: string[],
    tokensOut: string[],
    pool: Pool
  ): void => {
    if (
      tokensOut.length != amountsOut.length ||
      tokensOut.length != pool.tokensList.length
    ) {
      throw new BalancerError(BalancerErrorCode.INPUT_LENGTH_MISMATCH);
    }
    // Check if there's any important weighted pool info missing
    if (pool.tokens.some((token) => !token.decimals))
      throw new BalancerError(BalancerErrorCode.MISSING_DECIMALS);
  };
  sortValuesExitExactBptIn = ({
    pool,
    wrappedNativeAsset,
    shouldUnwrapNativeAsset,
    singleTokenOut,
  }: SortValuesExactBptInParams): ExactBPTInSortedValues => {
    const parsedPoolInfo = parsePoolInfo(
      pool,
      wrappedNativeAsset,
      shouldUnwrapNativeAsset
    );
    // Parse pool info into EVM amounts in order to match amountsIn scalling
    const { poolTokens } = parsedPoolInfo;
    let singleTokenOutIndex = -1;
    if (singleTokenOut) {
      singleTokenOutIndex = poolTokens.indexOf(singleTokenOut.toLowerCase());
    }
    return {
      ...parsedPoolInfo,
      singleTokenOutIndex,
    };
  };
  sortValuesExitExactTokensOut = ({
    pool,
    wrappedNativeAsset,
    amountsOut,
    tokensOut,
  }: SortValuesExactTokensOutParams): ExactTokensOutSortedValues => {
    const shouldUnwrapNativeAsset = tokensOut.some((a) => a === AddressZero);
    // Parse pool info into EVM amounts in order to match amountsOut scaling
    const parsedPoolInfo = parsePoolInfo(
      pool,
      wrappedNativeAsset,
      shouldUnwrapNativeAsset
    );
    const { scalingFactors } = parsedPoolInfo;

    const assetHelpers = new AssetHelpers(wrappedNativeAsset);
    // Sorts amounts in into ascending order (referenced to token addresses) to match the format expected by the Vault.
    const [, downScaledAmountsOut] = assetHelpers.sortTokens(
      tokensOut,
      amountsOut
    ) as [string[], string[]];

    // Maths should use upscaled amounts, e.g. 1USDC => 1e18 not 1e6
    const upScaledAmountsOut = _upscaleArray(
      downScaledAmountsOut.map((a) => BigInt(a)),
      scalingFactors.map((a) => BigInt(a))
    );

    return {
      ...parsedPoolInfo,
      upScaledAmountsOut,
      downScaledAmountsOut,
    };
  };
  calcTokenOutGivenExactBptIn = ({
    poolTokens,
    weights,
    upScaledBalances,
    totalSharesEvm,
    swapFeeEvm,
    singleTokenOutIndex,
    bptIn,
    slippage,
    scalingFactors,
  }: Pick<
    ExactBPTInSortedValues,
    | 'poolTokens'
    | 'weights'
    | 'upScaledBalances'
    | 'totalSharesEvm'
    | 'swapFeeEvm'
    | 'singleTokenOutIndex'
    | 'scalingFactors'
  > &
    Pick<ExitExactBPTInParameters, 'bptIn' | 'slippage'>): {
    minAmountsOut: string[];
    expectedAmountsOut: string[];
  } => {
    // Calculate amount out given BPT in
    const amountOut = SOR.WeightedMaths._calcTokenOutGivenExactBptIn(
      upScaledBalances[singleTokenOutIndex],
      weights[singleTokenOutIndex],
      BigInt(bptIn),
      totalSharesEvm,
      swapFeeEvm
    ).toString();

    const downscaledAmountOut = _downscaleDown(
      BigInt(amountOut) - BigInt(1), // The -1 is to solve rounding errors, sometimes the amount comes 1 point lower than expected
      scalingFactors[singleTokenOutIndex]
    ).toString();

    const expectedAmountsOut = Array(poolTokens.length).fill('0');
    const minAmountsOut = Array(poolTokens.length).fill('0');

    expectedAmountsOut[singleTokenOutIndex] = downscaledAmountOut;
    // Apply slippage tolerance
    minAmountsOut[singleTokenOutIndex] = subSlippage(
      BigNumber.from(downscaledAmountOut),
      BigNumber.from(slippage)
    ).toString();

    return { minAmountsOut, expectedAmountsOut };
  };

  calcTokensOutGivenExactBptIn = ({
    upScaledBalances,
    totalSharesEvm,
    scalingFactors,
    bptIn,
    slippage,
  }: Pick<
    ExactBPTInSortedValues,
    | 'upScaledBalances'
    | 'totalSharesEvm'
    | 'scalingFactors'
    | 'singleTokenOutIndex'
  > &
    Pick<ExitExactBPTInParameters, 'bptIn' | 'slippage'>): {
    minAmountsOut: string[];
    expectedAmountsOut: string[];
  } => {
    // Calculate amounts out given BPT in
    const amountsOut = SOR.WeightedMaths._calcTokensOutGivenExactBptIn(
      upScaledBalances,
      BigInt(bptIn),
      totalSharesEvm
    ).map((amount) => amount.toString());
    // Maths return numbers scaled to 18 decimals. Must scale down to token decimals.
    const amountsOutScaledDown = _downscaleDownArray(
      amountsOut.map((a) => BigInt(a)),
      scalingFactors
    );

    const expectedAmountsOut = amountsOutScaledDown.map((amount) =>
      amount.toString()
    );
    // Apply slippage tolerance
    const minAmountsOut = amountsOutScaledDown.map((amount) => {
      const minAmount = subSlippage(
        BigNumber.from(amount),
        BigNumber.from(slippage)
      );
      return minAmount.toString();
    });
    return { minAmountsOut, expectedAmountsOut };
  };
  calcBptInGivenExactTokensOut = ({
    weights,
    upScaledBalances,
    upScaledAmountsOut,
    totalSharesEvm,
    swapFeeEvm,
    slippage,
  }: CalcBptInGivenExactTokensOutParams): {
    maxBPTIn: string;
    expectedBPTIn: string;
  } => {
    // Calculate expected BPT in given tokens out
    const bptIn = SOR.WeightedMaths._calcBptInGivenExactTokensOut(
      upScaledBalances,
      weights,
      upScaledAmountsOut,
      totalSharesEvm,
      swapFeeEvm
    ).toString();

    // Apply slippage tolerance
    const maxBPTIn = addSlippage(
      BigNumber.from(bptIn),
      BigNumber.from(slippage)
    ).toString();
    return { maxBPTIn, expectedBPTIn: bptIn };
  };

  encodeExitPool = ({
    poolId,
    exiter,
    poolTokens,
    minAmountsOut,
    userData,
  }: EncodeExitParams): ExitPoolAttributes => {
    const to = balancerVault;
    const functionName = 'exitPool';
    const attributes: ExitPool = {
      poolId,
      sender: exiter,
      recipient: exiter,
      exitPoolRequest: {
        assets: poolTokens,
        minAmountsOut,
        userData,
        toInternalBalance: false,
      },
    };
    // Encode transaction data into an ABI byte string which can be sent to the network to be executed
    const vaultInterface = Vault__factory.createInterface();
    const data = vaultInterface.encodeFunctionData(functionName, [
      attributes.poolId,
      attributes.sender,
      attributes.recipient,
      attributes.exitPoolRequest,
    ]);
    return { data, to, functionName, attributes };
  };
}
