/**
 * Bài test này kiểm tra chức năng Transfer Hook Whitelist
 * Mục đích: Chỉ cho phép các account token có trong whitelist mới có thể nhận được token
 */

// Import các thư viện và module cần thiết
import * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,  // ID của Associated Token Program
  ExtensionType,                // Enum cho các loại extension của token
  TOKEN_2022_PROGRAM_ID,        // ID của Token-2022 Program
  createAssociatedTokenAccountInstruction,  // Tạo account token liên kết
  createInitializeMintInstruction,          // Khởi tạo mint token
  createInitializeTransferHookInstruction,   // Khởi tạo transfer hook cho mint
  createMintToInstruction,                  // Mint token vào account
  createTransferCheckedWithTransferHookInstruction,  // Chuyển token với transfer hook
  getAssociatedTokenAddressSync,  // Lấy địa chỉ account token liên kết
  getMintLen,                     // Tính kích thước account mint
} from '@solana/spl-token';
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import type { TransferHook } from '../target/types/transfer_hook';

describe('transfer-hook', () => {
  // Cấu hình client để sử dụng local cluster
  // AnchorProvider.env() sẽ lấy cấu hình từ biến môi trường (ví dụ: ANCHOR_PROVIDER_URL)
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Lấy instance của chương trình Transfer Hook từ workspace
  // Program<TransferHook> là kiểu từ file định nghĩa được tạo tự động khi build
  const program = anchor.workspace.TransferHook as Program<TransferHook>;
  const wallet = provider.wallet as anchor.Wallet;  // Ví dùng để ký giao dịch
  const connection = provider.connection;          // Kết nối đến Solana cluster

  // Tạo keypair mới để dùng làm địa chỉ cho mint token với transfer hook
  const mint = new Keypair();
  const decimals = 9;  // Số thập phân của token (10^9 = 1 token)

  // Tạo địa chỉ account token nguồn (của người gửi)
  // Associated Token Account là tiêu chuẩn account token được tạo từ địa chỉ ví và mint
  const sourceTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,        // Địa chỉ mint
    wallet.publicKey,      // Chủ sở hữu account
    false,                 // allowOwnerOffCurve: false
    TOKEN_2022_PROGRAM_ID, // Sử dụng Token-2022 thay vì Token standard
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Tạo địa chỉ account token đích (người nhận)
  const recipient = Keypair.generate();  // Tạo ví mới cho người nhận
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    recipient.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Tạo địa chỉ account token cho người nhận không nằm trong whitelist
  // Dùng để kiểm tra trường hợp chuyển token đến account không được phép
  const nonWhitelistedRecipient = Keypair.generate();
  const nonWhitelistedDestinationTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    nonWhitelistedRecipient.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // ======================================================================
  // TEST CASE 1: Tạo account Mint với Transfer Hook Extension
  // ======================================================================
  /**
   * Các bước:
   * 1. Tính kích thước cần thiết cho account mint với extension
   * 2. Tạo account mới (createAccount)
   * 3. Khởi tạo Transfer Hook extension cho mint (initializeTransferHook)
   * 4. Khởi tạo mint token (initializeMint)
   */
  it('Create Mint Account with Transfer Hook Extension', async () => {
    // Định nghĩa extensions cần thiết cho mint (chỉ TransferHook trong trường hợp này)
    const extensions = [ExtensionType.TransferHook];
    // Tính kích thước cần thiết cho account mint
    const mintLen = getMintLen(extensions);
    // Tính số lamports cần thiết để account được miễn phí rent
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    // Tạo transaction với 3 instruction
    const transaction = new Transaction().add(
      // 1. Tạo account mới để làm mint
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,         // Người trả phí
        newAccountPubkey: mint.publicKey,     // Địa chỉ account mới
        space: mintLen,                       // Kích thước account
        lamports: lamports,                   // Số lamports cần thiết
        programId: TOKEN_2022_PROGRAM_ID,     // account thuộc Token-2022 Program
      }),
      // 2. Khởi tạo Transfer Hook extension cho mint
      createInitializeTransferHookInstruction(
        mint.publicKey,          // Địa chỉ mint
        wallet.publicKey,        // Authority của mint
        program.programId,       // Program ID của Transfer Hook (program chúng ta viết)
        TOKEN_2022_PROGRAM_ID,   // Token-2022 Program ID
      ),
      // 3. Khởi tạo mint token
      createInitializeMintInstruction(
        mint.publicKey,          // Địa chỉ mint
        decimals,                // Số thập phân
        wallet.publicKey,        // Mint Authority
        null,                    // Freeze Authority (null = không có)
        TOKEN_2022_PROGRAM_ID    // Token-2022 Program ID
      ),
    );

    // Gửi và xác nhận transaction
    const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer, mint]);
    console.log(`Transaction Signature: ${txSig}`);
  });

  // ======================================================================
  // TEST CASE 2: Tạo các account Token và Mint Tokens
  // ======================================================================
  /**
   * Các bước:
   * 1. Tạo account token nguồn (sourceTokenAccount)
   * 2. Tạo account token đích có trong whitelist (destinationTokenAccount)
   * 3. Tạo account token đích không có trong whitelist (nonWhitelistedDestinationTokenAccount)
   * 4. Mint 100 tokens vào account nguồn
   */
  it('Create Token Accounts and Mint Tokens', async () => {
    // Số lượng token mint: 100 tokens (nhân với 10^decimals để lấy số đơn vị nhỏ nhất)
    const amount = 100 * 10 ** decimals;

    // Tạo transaction với 4 instruction
    const transaction = new Transaction().add(
      // 1. Tạo account token nguồn (cho người gửi/owner)
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,               // Payer (người trả phí)
        sourceTokenAccount,             // Địa chỉ account token
        wallet.publicKey,               // Owner của account token
        mint.publicKey,                 // Mint token
        TOKEN_2022_PROGRAM_ID,          // Token-2022 Program ID
        ASSOCIATED_TOKEN_PROGRAM_ID,    // Associated Token Program ID
      ),
      // 2. Tạo account token đích (cho người nhận hợp lệ)
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        destinationTokenAccount,
        recipient.publicKey,             // Owner là recipient
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      // 3. Tạo account token đích (cho người nhận không hợp lệ)
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        nonWhitelistedDestinationTokenAccount,
        nonWhitelistedRecipient.publicKey,  // Owner là nonWhitelistedRecipient
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      // 4. Mint 100 tokens vào account nguồn
      createMintToInstruction(
        mint.publicKey,         // Mint address
        sourceTokenAccount,     // account nhận token
        wallet.publicKey,       // Mint authority
        amount,                 // Số lượng token mint
        [],                     // Signers (trống vì wallet.publicKey là mint authority)
        TOKEN_2022_PROGRAM_ID   // Token-2022 Program ID
      ),
    );

    // Gửi và xác nhận transaction
    // skipPreflight: true - bỏ qua việc kiểm tra transaction trước khi gửi
    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });

    console.log(`Transaction Signature: ${txSig}`);
  });

  // ======================================================================
  // TEST CASE 3: Tạo account ExtraAccountMetaList
  // ======================================================================
  /**
   * Đây là bước quan trọng cho Transfer Hook. ExtraAccountMetaList lưu trữ
   * danh sách các account bổ sung cần thiết khi thực hiện transfer hook.
   * Trong trường hợp này, nó chứa thông tin về account whitelist.
   */
  it('Create ExtraAccountMetaList Account', async () => {
    // Tạo instruction gọi hàm initializeExtraAccountMetaList từ program
    const initializeExtraAccountMetaListInstruction = await program.methods
      .initializeExtraAccountMetaList()   // Gọi hàm initializeExtraAccountMetaList trong contract
      .accounts({
        mint: mint.publicKey,             // Truyền account mint
        // Các account khác như payer, extra_account_meta_list, system_program
        // được tự động thêm vào nhờ Anchor context
      })
      .instruction();

    // Tạo và gửi transaction
    const transaction = new Transaction().add(initializeExtraAccountMetaListInstruction);

    // Gửi và xác nhận transaction
    // skipPreflight: true - bỏ qua kiểm tra trước khi gửi
    // commitment: 'confirmed' - chờ đến khi transaction được xác nhận
    const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer], { skipPreflight: true, commitment: 'confirmed' });

    console.log('Transaction Signature:', txSig);
  });

  // ======================================================================
  // TEST CASE 4: Thêm account vào whitelist
  // ======================================================================
  /**
   * Thêm destinationTokenAccount vào whitelist để cho phép
   * chuyển token đến account này.
   */
  it('Add account to white list', async () => {
    // Tạo instruction gọi hàm addToWhitelist từ program
    const addAccountToWhiteListInstruction = await program.methods
      .addToWhitelist()         // Gọi hàm addToWhitelist trong contract
      .accounts({
        newAccount: destinationTokenAccount,  // account cần thêm vào whitelist
        signer: wallet.publicKey,             // Người ký (phải là authority của whitelist)
        // white_list được tự động thêm vào từ Anchor context
      })
      .instruction();

    // Tạo và gửi transaction
    const transaction = new Transaction().add(addAccountToWhiteListInstruction);

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log('White Listed:', txSig);
  });

  // ======================================================================
  // TEST CASE 5: Chuyển token đến account có trong whitelist
  // ======================================================================
  /**
   * Bước này kiểm tra việc chuyển token đến account đã được thêm vào whitelist.
   * Vì destinationTokenAccount đã được thêm vào whitelist, nên chuyển token đến
   * account này sẽ thành công.
   */
  it('Transfer Hook with Extra Account Meta - To Whitelisted Account (Should Succeed)', async () => {
    // Số lượng token chuyển: 1 token
    const amount = 1 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);  // Chuyển sang BigInt vì API mới yêu cầu

    // Tạo transfer instruction với transfer hook
    // Hàm này sẽ tự động thêm các account bổ sung cần thiết từ ExtraAccountMetaList
    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,                 // Kết nối đến Solana cluster
      sourceTokenAccount,         // account nguồn
      mint.publicKey,             // Mint token
      destinationTokenAccount,    // account đích (đã có trong whitelist)
      wallet.publicKey,           // Authority của account nguồn
      bigIntAmount,               // Số lượng token chuyển
      decimals,                   // Số thập phân của token
      [],                         // Signers bổ sung (không cần)
      'confirmed',                // Commitment level
      TOKEN_2022_PROGRAM_ID,      // Token-2022 Program ID
    );

    // Tạo và gửi transaction
    const transaction = new Transaction().add(transferInstruction);

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log('Transfer to Whitelisted Account Succeeded:', txSig);
  });

  // ======================================================================
  // TEST CASE 6: Xóa account khỏi whitelist
  // ======================================================================
  /**
   * Xóa destinationTokenAccount khỏi whitelist để chuẩn bị cho
   * test case tiếp theo (chuyển token đến account đã bị xóa khỏi whitelist).
   */
  it('Remove account from white list', async () => {
    // Tạo instruction gọi hàm removeFromWhitelist từ program
    const removeFromWhiteListInstruction = await program.methods
      .removeFromWhitelist()     // Gọi hàm removeFromWhitelist trong contract
      .accounts({
        accountToRemove: destinationTokenAccount,  // account cần xóa
        signer: wallet.publicKey,                 // Người ký (phải là authority)
        // white_list được tự động thêm vào từ Anchor context
      })
      .instruction();

    // Tạo và gửi transaction
    const transaction = new Transaction().add(removeFromWhiteListInstruction);

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
    console.log('Removed from White List:', txSig);
  });

  // ======================================================================
  // TEST CASE 7: Chuyển token đến account đã bị xóa khỏi whitelist
  // ======================================================================
  /**
   * Bước này kiểm tra việc chuyển token đến account đã bị xóa khỏi whitelist.
   * Vì destinationTokenAccount đã bị xóa khỏi whitelist, nên chuyển token đến
   * account này sẽ thất bại.
   */
  it('Transfer Hook with Extra Account Meta - To Removed Account (Should Fail)', async () => {
    // Số lượng token chuyển: 1 token
    const amount = 1 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);

    // Tạo transfer instruction với transfer hook
    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sourceTokenAccount,
      mint.publicKey,
      destinationTokenAccount,    // account đã bị xóa khỏi whitelist
      wallet.publicKey,
      bigIntAmount,
      decimals,
      [],
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );

    // Tạo và gửi transaction
    const transaction = new Transaction().add(transferInstruction);

    // Bọc trong try-catch vì chúng ta kỳ vọng transaction sẽ thất bại
    try {
      await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
      console.log('ERROR: Transfer to Removed Account Unexpectedly Succeeded');
      throw new Error('Transfer to removed account should have failed but succeeded');
    } catch (error: any) {
      // Báo lỗi đúng như kỳ vọng
      console.log('Expected Error - Transfer to Removed Account Failed:', error.message);
    }
  });

  // ======================================================================
  // TEST CASE 8: Chuyển token đến account không có trong whitelist
  // ======================================================================
  /**
   * Bước này kiểm tra việc chuyển token đến account chưa bao giờ được thêm vào whitelist.
   * Vì nonWhitelistedDestinationTokenAccount không có trong whitelist, nên chuyển token
   * đến account này sẽ thất bại.
   */
  it('Transfer Hook with Extra Account Meta - To Non-Whitelisted Account (Should Fail)', async () => {
    // Số lượng token chuyển: 1 token
    const amount = 1 * 10 ** decimals;
    const bigIntAmount = BigInt(amount);

    // Tạo transfer instruction với transfer hook
    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sourceTokenAccount,
      mint.publicKey,
      nonWhitelistedDestinationTokenAccount,  // account không có trong whitelist
      wallet.publicKey,
      bigIntAmount,
      decimals,
      [],
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );

    // Tạo và gửi transaction
    const transaction = new Transaction().add(transferInstruction);

    // Bọc trong try-catch vì chúng ta kỳ vọng transaction sẽ thất bại
    try {
      await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
      console.log('ERROR: Transfer to Non-Whitelisted Account Unexpectedly Succeeded');
      throw new Error('Transfer to non-whitelisted account should have failed but succeeded');
    } catch (error: any) {
      // Báo lỗi đúng như kỳ vọng
      console.log('Expected Error - Transfer to Non-Whitelisted Account Failed:', error.message);
    }
  });
});
