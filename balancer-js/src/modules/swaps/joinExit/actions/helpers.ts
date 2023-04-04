import { BigNumber } from '@ethersproject/bignumber';
import { Relayer, OutputReference } from '@/modules/relayer/relayer.module';
import { subSlippage } from '@/lib/utils/slippageHelper';
import { ActionStep, ActionType, Actions } from './types';
import { Swap } from './swap';

/**
 * If its not the first action then the amount will come from the previous output ref
 * @param amount
 * @param actionType
 * @param actionStep
 * @param opRefKey
 * @returns
 */
export function getActionAmount(
  amount: string,
  actionType: ActionType,
  actionStep: ActionStep,
  opRefKey: number
): string {
  let amountIn = amount;
  if (
    actionStep === ActionStep.TokenOut ||
    (actionStep === ActionStep.Middle && actionType === ActionType.Join) ||
    (actionStep === ActionStep.Middle && actionType === ActionType.Exit)
  ) {
    amountIn = Relayer.toChainedReference(opRefKey - 1).toString();
  }
  return amountIn;
}

function getOutputRef(key: number, index: number): OutputReference {
  const keyRef = Relayer.toChainedReference(key);
  return { index: index, key: keyRef };
}

/**
 * If its not the final action then we need an outputReferece to chain to next action as input
 * @param actionStep
 * @param tokenOutIndex
 * @param opRefKey
 * @returns
 */
export function getActionOutputRef(
  actionStep: ActionStep,
  tokenOutIndex: number,
  opRefKey: number
): [OutputReference, number] {
  let opRef: OutputReference = {} as OutputReference;
  if (actionStep === ActionStep.TokenIn || actionStep === ActionStep.Middle) {
    opRef = getOutputRef(opRefKey, tokenOutIndex);
    opRefKey++;
  }
  return [opRef, opRefKey];
}

/**
 * Use slippage to set min amount out
 * @param amountOut
 * @param slippage
 * @returns
 */
export function getActionMinOut(amountOut: string, slippage: string): string {
  // Currently only handle ExactIn swap. ExactOut would add slippage
  // We should apply slippage to each swaps amountOut
  return subSlippage(
    BigNumber.from(amountOut),
    BigNumber.from(slippage)
  ).toString();
}

/**
 * Find if the Action is:
 * Direct: tokenIn > tokenOut
 * TokenIn: tokenIn > chain...
 * TokenOut: ...chain > tokenOut
 * Middle: ...chain > action > chain...
 * @param tokenInIndex
 * @param tokenOutIndex
 * @param tokenInIndexAction
 * @param tokenOutIndexAction
 * @returns
 */
export function getActionStep(
  tokenInIndex: number,
  tokenOutIndex: number,
  tokenInIndexAction: number,
  tokenOutIndexAction: number
): ActionStep {
  let actionStep: ActionStep;
  if (
    tokenInIndexAction === tokenInIndex &&
    tokenOutIndexAction === tokenOutIndex
  ) {
    actionStep = ActionStep.Direct;
  } else if (tokenInIndexAction === tokenInIndex) {
    actionStep = ActionStep.TokenIn;
  } else if (tokenOutIndexAction === tokenOutIndex) {
    actionStep = ActionStep.TokenOut;
  } else {
    actionStep = ActionStep.Middle;
  }
  return actionStep;
}

/**
 * Find the number of actions that end with tokenOut
 * @param actions
 * @returns
 */
export function getNumberOfOutputActions(actions: Actions[]): number {
  let outputCount = 0;
  for (const a of actions) {
    if (a.hasTokenOut) outputCount++;
  }
  return outputCount;
}

/**
 * Categorize each action into a Join, Middle or Exit.
 * @param actions
 * @returns
 */
export function categorizeActions(actions: Actions[]): Actions[] {
  const enterActions: Actions[] = [];
  const exitActions: Actions[] = [];
  const middleActions: Actions[] = [];
  for (const a of actions) {
    if (a.type === ActionType.Exit || a.type === ActionType.Join) {
      // joins/exits with tokenIn can always be done first
      if (a.hasTokenIn) enterActions.push(a);
      // joins/exits with tokenOut (and not tokenIn) can always be done last
      else if (a.hasTokenOut) exitActions.push(a);
      else middleActions.push(a);
    }
    // All other actions will be chained inbetween
    else middleActions.push(a);
  }
  const allActions: Actions[] = [
    ...enterActions,
    ...middleActions,
    ...exitActions,
  ];
  return allActions;
}

/**
 * This aims to minimise the number of Actions the Relayer multicall needs to call by batching sequential swaps together.
 * @param actions
 * @param assets
 * @returns
 */
export function batchSwapActions(allActions: Actions[]): Actions[] {
  /*
  batchSwaps are a collection of swaps that can all be called in a single batchSwap
  Can batch all swaps with same source
  Any swap without tokenIn && not BPT should be coming from internal balances
  Any swap with tokenIn or BPT should be coming from external balances
  */
  const orderedActions: Actions[] = [];
  let batchedSwaps: Swap | undefined = undefined;

  for (const a of allActions) {
    if (a.type === ActionType.BatchSwap) {
      if (!batchedSwaps) {
        batchedSwaps = a.copy();
      } else {
        if (batchedSwaps.canAddSwap(a)) {
          batchedSwaps.addSwap(a);
        } else {
          orderedActions.push(batchedSwaps);
          batchedSwaps = a.copy();
        }
      }
    } else {
      // Non swap action
      if (batchedSwaps) {
        orderedActions.push(batchedSwaps);
        // new batchSwap collection as there is a chained join/exit inbetween
        batchedSwaps = undefined;
      }
      orderedActions.push(a);
    }
  }
  if (batchedSwaps && batchedSwaps.swaps.length === 1)
    orderedActions.push(batchedSwaps);

  return orderedActions;
}

/**
 * Organise Actions into order with least amount of calls.
 * @param actions
 * @param assets
 * @returns
 */
export function orderActions(actions: Actions[]): Actions[] {
  const categorizedActions = categorizeActions(actions);
  const orderedActions = batchSwapActions(categorizedActions);
  return orderedActions;
}
