// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPositionNFT {
    function ownerOf(uint256 id) external view returns(address);
    function transferFrom(address from,address to,uint256 id) external;
    function approve(address spender,uint256 id) external;
    function getPosition(uint256 id) external view returns(uint256,uint256);
}
interface IConverter {
    function queryConvert(uint256 amount,uint256 encoding,uint256[] calldata routes) external returns(uint256);
    function convert(address token,uint256 amount,uint256 encoding,uint256[] calldata routes) external payable returns(uint256);
}
interface IBalancer {
    function flashLoan(address recipient,address[] calldata tokens,uint256[] calldata amounts,bytes calldata data) external;
}
interface IPoolConfiguration {
    function getPoolFeeRatio(address pool,address sender) external view returns(uint256,uint256,uint256,uint256);
}
interface IFxMintRouter {
    struct ConvertIn {address tokenIn;uint256 amount;address target;bytes data;uint256 minOut;bytes signature;}
    struct Repay {address pool;uint256 positionId;uint256 withdrawAmount;}
    function repayToLong(ConvertIn calldata input,Repay calldata repay) external payable;
}

/// @notice Restricted owner-only repayment; uses the existing approved fxMint router.
/// @dev Routing copied from AladdinDAO/fx-sdk src/configs/routers.ts.
/// Balancer callback flow follows AladdinDAO FlashLoanCallbackFacet's authenticated callback/repay pattern.
contract FxMintEthRepayer_v1 {
    using SafeERC20 for IERC20;
    address public immutable owner;
    address public constant POOL=0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8;
    address public constant ROUTER=0xB753366082466c4B5984312f0c4Bb97554be067E;
    address public constant CONVERTER=0x12AF4529129303D7FbD2563E242C4a2890525912;
    address public constant BALANCER=0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address public constant USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant FXUSD=0x085780639CC2cACd35E474e71f4d000e2405d8f6;
    address public constant WSTETH=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address public constant CONFIGURATION=0x16b334f2644cc00b85DB1A1efF0C2C395e00C28d;
    uint8 private state;
    bytes32 private activeHash;
    struct Plan {uint256 positionId;uint256 debtRepayment;uint256 flashUsdc;uint256 withdrawCollateral;uint256 firstMinimum;uint256 secondMinimum;uint256 deadline;uint256[] firstRoutes;uint256[] collateralRoutes;}
    event Swap(address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 minimum);
    event DebtRepaid(uint256 indexed positionId,uint256 fxusdSpent,uint256 debtBefore,uint256 debtAfter);
    event FlashLoanRepaid(uint256 principal,uint256 fee,uint256 collateralWithdrawn,uint256 finalUsdc);
    event Completed(uint256 indexed positionId,uint256 debtBefore,uint256 debtAfter,uint256 collateralBefore,uint256 collateralAfter);
    error Unauthorized();error InvalidPlan();error InsufficientOutput();error CallbackOnly();
    constructor(address owner_){if(owner_==address(0))revert InvalidPlan();owner=owner_;}
    function execute(Plan calldata plan) external {
        if(msg.sender!=owner)revert Unauthorized();
        if(state!=0||block.timestamp>plan.deadline||plan.debtRepayment==0||plan.flashUsdc==0||plan.withdrawCollateral==0||plan.firstMinimum==0||plan.secondMinimum<plan.flashUsdc||plan.firstRoutes.length==0||plan.firstRoutes.length>6||plan.collateralRoutes.length==0||plan.collateralRoutes.length>6)revert InvalidPlan();
        if(IPositionNFT(POOL).ownerOf(plan.positionId)!=owner)revert Unauthorized();
        (uint256 beforeColl,uint256 beforeDebt)=IPositionNFT(POOL).getPosition(plan.positionId);
        if(beforeDebt<plan.debtRepayment)revert InvalidPlan();
        state=1;bytes memory data=abi.encode(plan);activeHash=keccak256(data);
        IPositionNFT(POOL).transferFrom(owner,address(this),plan.positionId);
        address[] memory tokens=new address[](1);tokens[0]=USDC;
        uint256[] memory amounts=new uint256[](1);amounts[0]=plan.flashUsdc;
        IBalancer(BALANCER).flashLoan(address(this),tokens,amounts,data);
        if(state!=3)revert CallbackOnly();
        (uint256 afterColl,uint256 afterDebt)=IPositionNFT(POOL).getPosition(plan.positionId);
        if(afterDebt>=beforeDebt||afterColl>=beforeColl)revert InvalidPlan();
        IPositionNFT(POOL).transferFrom(address(this),owner,plan.positionId);
        _refund(USDC);_refund(FXUSD);_refund(WSTETH);
        emit Completed(plan.positionId,beforeDebt,afterDebt,beforeColl,afterColl);
        activeHash=bytes32(0);state=0;
    }
    function receiveFlashLoan(address[] calldata tokens,uint256[] calldata amounts,uint256[] calldata fees,bytes calldata data) external {
        if(msg.sender!=BALANCER||state!=1||keccak256(data)!=activeHash)revert CallbackOnly();
        Plan memory plan=abi.decode(data,(Plan));
        if(tokens.length!=1||amounts.length!=1||fees.length!=1||tokens[0]!=USDC||amounts[0]!=plan.flashUsdc)revert CallbackOnly();
        state=2;
        uint256 fx=_swap(USDC,FXUSD,plan.flashUsdc,plan.firstRoutes,plan.firstMinimum,10);
        (uint256 beforeColl,uint256 beforeDebt)=IPositionNFT(POOL).getPosition(plan.positionId);
        IPositionNFT(POOL).approve(ROUTER,plan.positionId);
        (,,,uint256 repaymentFee)=IPoolConfiguration(CONFIGURATION).getPoolFeeRatio(POOL,ROUTER);
        uint256 repaymentAmount=(plan.debtRepayment*(1e9+repaymentFee)+1e9-1)/1e9;
        if(fx<repaymentAmount)revert InsufficientOutput();
        IERC20(FXUSD).forceApprove(ROUTER,repaymentAmount);
        // Use one official operation: PoolConfiguration forbids a second manager operation in the same transaction.
        // The router accounts for repayment fees and applies debt paydown and collateral withdrawal together.
        IFxMintRouter.ConvertIn memory input=IFxMintRouter.ConvertIn(FXUSD,repaymentAmount,CONVERTER,"",0,"");
        uint256 collateralBefore=IERC20(WSTETH).balanceOf(address(this));
        IFxMintRouter(ROUTER).repayToLong(input,IFxMintRouter.Repay(POOL,plan.positionId,plan.withdrawCollateral));
        IERC20(FXUSD).forceApprove(ROUTER,0);
        (,uint256 afterDebt)=IPositionNFT(POOL).getPosition(plan.positionId);
        if(afterDebt>=beforeDebt)revert InvalidPlan();
        uint256 reduced=beforeDebt-afterDebt;
        if(reduced>plan.debtRepayment ? reduced-plan.debtRepayment>1e12 : plan.debtRepayment-reduced>1e12)revert InvalidPlan();
        emit DebtRepaid(plan.positionId,repaymentAmount,beforeDebt,afterDebt);
        uint256 collateral=IERC20(WSTETH).balanceOf(address(this))-collateralBefore;
        uint256 due=plan.flashUsdc+fees[0];
        if(plan.secondMinimum<due)revert InvalidPlan();
        uint256 usdc=_swap(WSTETH,USDC,collateral,plan.collateralRoutes,plan.secondMinimum,25);
        IERC20(USDC).safeTransfer(BALANCER,due);
        emit FlashLoanRepaid(plan.flashUsdc,fees[0],collateral,usdc);
        (uint256 afterColl,)=IPositionNFT(POOL).getPosition(plan.positionId);
        if(afterColl>=beforeColl)revert InvalidPlan();
        state=3;
    }
    function _swap(address from,address to,uint256 amount,uint256[] memory routes,uint256 floor,uint256 bps) private returns(uint256 out){
        uint256 enc=1048575+(routes.length<<20);
        uint256 q=IConverter(CONVERTER).queryConvert(amount,enc,routes);
        uint256 quotedMinimum=q*(10000-bps)/10000;
        uint256 minimum=quotedMinimum>floor?quotedMinimum:floor;
        IERC20(from).forceApprove(CONVERTER,amount);
        uint256 beforeBalance=IERC20(to).balanceOf(address(this));
        IConverter(CONVERTER).convert(from,amount,enc,routes);
        IERC20(from).forceApprove(CONVERTER,0);
        out=IERC20(to).balanceOf(address(this))-beforeBalance;
        if(out<minimum)revert InsufficientOutput();
        emit Swap(from,to,amount,out,minimum);
    }
    function _refund(address token) private {uint256 amount=IERC20(token).balanceOf(address(this));if(amount>0)IERC20(token).safeTransfer(owner,amount);}
}
