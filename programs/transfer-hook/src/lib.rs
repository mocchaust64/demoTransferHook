/*
 * Smart Contract Transfer Hook Whitelist
 *
 * Contract này triển khai cơ chế Transfer Hook của SPL-Token-2022 để kiểm soát
 * việc chuyển token dựa trên một danh sách (whitelist).
 * Chỉ các địa chỉ có trong whitelist mới có thể nhận được token.
 */

// PHẦN 1: IMPORTS VÀ KHAI BÁO ID
// RefMut cho phép truy cập và chỉnh sửa dữ liệu một cách an toàn
// đây là một tham chiếu "mượn" có thể thay đổi giá trị (mutable borrow)
use std::cell::RefMut;

// Import các module từ thư viện Anchor - framework phát triển cho Solana
use anchor_lang::prelude::*;
// Import các module liên quan đến Token từ SPL (Solana Program Library)
use anchor_spl::{
    // Token-2022 là phiên bản mới của token standard với nhiều tính năng mở rộng
    token_2022::spl_token_2022::{
        extension::{
            // TransferHookAccount: Extension chứa thông tin về trạng thái chuyển token
            transfer_hook::TransferHookAccount,
            // Các trait để làm việc với trạng thái và extension của account
            BaseStateWithExtensionsMut,
            PodStateWithExtensionsMut,
        },
        // PodAccount: Cấu trúc "Plain Old Data" để lưu trữ dữ liệu account token
        pod::PodAccount,
    },
    // Interface cho Mint và TokenAccount, hoạt động với cả token tiêu chuẩn và token-2022
    token_interface::{ Mint, TokenAccount },
};
// Thư viện để xử lý các account bổ sung cần thiết cho transfer hook
use spl_tlv_account_resolution::{
    // ExtraAccountMeta: Định nghĩa các account bổ sung cần được cung cấp
    account::ExtraAccountMeta,
    // Seed: Được sử dụng để tạo và tìm các PDA (Program Derived Address)
    seeds::Seed,
    // ExtraAccountMetaList: Quản lý danh sách các account bổ sung
    state::ExtraAccountMetaList,
};
// Import các định nghĩa từ Transfer Hook Interface
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

// Khai báo ID của program này trên Solana blockchain
// ID này phải khớp với địa chỉ của program khi được triển khai
declare_id!("BmcmrHRjV2feBspwFsmWWwzNThT5o6sKM1zwoQcjKoG");

// PHẦN 2: ENUM LỖI
// Định nghĩa các mã lỗi có thể xảy ra trong program
#[error_code]
pub enum TransferError {
    // Lỗi khi cố gọi hàm transfer_hook không trong ngữ cảnh chuyển token
    // Đây là biện pháp bảo mật quan trọng để ngăn chặn các cuộc tấn công trực tiếp
    #[msg("The token is not currently transferring")]
    IsNotCurrentlyTransferring,
    // Lỗi khi không tìm thấy địa chỉ trong whitelist (cho hàm remove_from_whitelist)
    #[msg("Account not found in whitelist")]
    AccountNotFound,
}

// PHẦN 3: CẤU TRÚC DỮ LIỆU CƠ BẢN
/*
 * Định nghĩa cấu trúc dữ liệu của account whitelist
 */
#[account]
pub struct WhiteList {
    // Địa chỉ có quyền thêm/xóa địa chỉ trong whitelist
    pub authority: Pubkey,
    // Danh sách các địa chỉ được phép (whitelist)
    // Lưu ý: Vector này có kích thước động và giới hạn bởi kích thước
    // của account (400 bytes đã được cấp phát)
    // Mỗi Pubkey chiếm 32 bytes, nên whitelist có thể chứa tối đa khoảng 10-12 địa chỉ
    // tùy thuộc vào các metadata khác
    pub white_list: Vec<Pubkey>,
}

// PHẦN 4: CÁC CẤU TRÚC account VÀ LOGIC LIÊN QUAN
/*
 * Định nghĩa cấu trúc account cho hàm khởi tạo ExtraAccountMetaList
 *
 * Mô tả các account cần thiết và cách chúng được xác thực
 * khi gọi hàm initialize_extra_account_meta_list
 */
#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    // Người trả phí cho việc tạo account
    // mut: account này có thể bị trừ lamports
    #[account(mut)]
    payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList Account, must use these seeds
    // account PDA lưu trữ thông tin về các account bổ sung
    // Được tạo từ seeds bao gồm "extra-account-metas" và địa chỉ của mint
    // Đây là account quan trọng cho Transfer Hook, Token-2022 sẽ sử dụng nó
    // để biết cần truy xuất account bổ sung nào khi chuyển token
    #[account(
        init,  // Khởi tạo account mới
        seeds = [b"extra-account-metas", mint.key().as_ref()],  // Seeds để tạo PDA
        bump,  // Bump seed sẽ được tự động tính toán
        space = ExtraAccountMetaList::size_of(  // Kích thước của account
            InitializeExtraAccountMetaList::extra_account_metas()?.len()
        )?,
        payer = payer  // Người trả phí cho việc tạo account
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    // account mint của token
    pub mint: InterfaceAccount<'info, Mint>,
    // System Program, cần thiết để tạo account
    pub system_program: Program<'info, System>,
    // account lưu trữ whitelist
    // Được tạo từ seed "white_list"
    // init_if_needed: Tạo mới nếu chưa tồn tại
    // space = 400: Cấp phát 400 bytes cho account
    // Lưu ý: Kích thước cố định này giới hạn số lượng địa chỉ có thể thêm vào whitelist
    #[account(init_if_needed, seeds = [b"white_list"], bump, payer = payer, space = 400)]
    pub white_list: Account<'info, WhiteList>,
}

/*
 * Định nghĩa các account bổ sung cần thiết cho Transfer Hook
 * 
 * Mô tả các account bổ sung cần được cung cấp tự động
 * khi Token-2022 gọi transfer hook
 */
impl<'info> InitializeExtraAccountMetaList<'info> {
    pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
        Ok(
            vec![
                // Chỉ có một account bổ sung là white_list
                ExtraAccountMeta::new_with_seeds(
                    &[
                        // Seed để tạo PDA cho account white_list
                        Seed::Literal {
                            bytes: "white_list".as_bytes().to_vec(),
                        },
                    ],
                    false, // is_signer: false - không yêu cầu account này là signer
                    true // is_writable: true - account này cần có quyền ghi
                )?
            ]
        )
    }
}

/*
 * Định nghĩa cấu trúc account cho hàm Transfer Hook
 * 
 * QUAN TRỌNG: Thứ tự 4 account đầu tiên PHẢI theo đúng thứ tự:
 * source_token, mint, destination_token, owner
 * Đây là yêu cầu của Transfer Hook Interface
 */
#[derive(Accounts)]
pub struct TransferHook<'info> {
    // account token nguồn
    // Phải thỏa mãn: token::mint = mint, token::authority = owner
    #[account(token::mint = mint, token::authority = owner)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    // account mint của token
    pub mint: InterfaceAccount<'info, Mint>,
    // account token đích
    // Phải thỏa mãn: token::mint = mint
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source token account owner, can be SystemAccount or PDA owned by another program
    // Chủ sở hữu của account nguồn
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList Account,
    // account lưu trữ thông tin về các account bổ sung
    // Được xác định bằng PDA từ seed "extra-account-metas" và địa chỉ mint
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    // account lưu trữ whitelist
    // Được xác định bằng PDA từ seed "white_list"
    #[account(seeds = [b"white_list"], bump)]
    pub white_list: Account<'info, WhiteList>,
}

/*
 * Định nghĩa cấu trúc account cho hàm thêm vào whitelist
 */
#[derive(Accounts)]
pub struct AddToWhiteList<'info> {
    /// CHECK: New account to add to white list
    // Địa chỉ mới cần thêm vào whitelist
    // Không cần kiểm tra gì về account này
    #[account()]
    pub new_account: AccountInfo<'info>,
    // account whitelist, cần có quyền ghi để cập nhật
    // mut: account này sẽ bị chỉnh sửa (thêm địa chỉ mới)
    #[account(
        mut,
        seeds = [b"white_list"],
        bump
    )]
    pub white_list: Account<'info, WhiteList>,
    // Người ký giao dịch, phải là authority của whitelist
    // mut: account này sẽ trả phí giao dịch
    #[account(mut)]
    pub signer: Signer<'info>,
}

/*
 * Định nghĩa cấu trúc account cho hàm xóa khỏi whitelist
 */
#[derive(Accounts)]
pub struct RemoveFromWhiteList<'info> {
    /// CHECK: Account to remove from white list
    // Địa chỉ cần xóa khỏi whitelist
    // Không cần kiểm tra gì về account này
    #[account()]
    pub account_to_remove: AccountInfo<'info>,
    // account whitelist, cần có quyền ghi để cập nhật
    // mut: account này sẽ bị chỉnh sửa (xóa địa chỉ)
    #[account(
        mut,
        seeds = [b"white_list"],
        bump
    )]
    pub white_list: Account<'info, WhiteList>,
    // Người ký giao dịch, phải là authority của whitelist
    // mut: account này sẽ trả phí giao dịch
    #[account(mut)]
    pub signer: Signer<'info>,
}

// PHẦN 5: MODULE CHƯƠNG TRÌNH CHÍNH
// Định nghĩa các hàm xử lý (entry points) của smart contract
#[program]
pub mod transfer_hook {
    use super::*;

    /*
     * Hàm khởi tạo ExtraAccountMetaList
     * 
     * Đây là hàm bắt buộc phải triển khai theo Transfer Hook Interface
     * Mục đích: Tạo và khởi tạo account ExtraAccountMetaList chứa thông tin
     * về các account bổ sung cần được cung cấp khi thực hiện chuyển token
     * 
     * QUAN TRỌNG: Hàm này phải được gọi trước khi có thể sử dụng transfer hook
     */
    #[interface(spl_transfer_hook_interface::initialize_extra_account_meta_list)]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>
    ) -> Result<()> {
        // Thiết lập quyền sở hữu (authority) của whitelist là người trả phí (payer)
        // Điều này xác định ai có quyền thêm/xóa địa chỉ trong whitelist
        ctx.accounts.white_list.authority = ctx.accounts.payer.key();

        // Lấy danh sách các account bổ sung cần thiết cho transfer hook
        // Trong trường hợp này, chỉ có một account bổ sung là white_list
        let extra_account_metas = InitializeExtraAccountMetaList::extra_account_metas()?;

        // Khởi tạo account ExtraAccountMetaList với danh sách các account bổ sung
        // Token-2022 sẽ sử dụng account này để biết cần truy xuất account bổ sung nào
        // khi thực hiện chuyển token
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas
        )?;
        Ok(())
    }

    /*
     * Hàm Transfer Hook chính
     * 
     * Đây là hàm bắt buộc phải triển khai theo Transfer Hook Interface
     * Mục đích: Được Token-2022 tự động gọi khi có lệnh chuyển token
     * 
     * QUAN TRỌNG: Hàm này được gọi tự động, không cần gọi trực tiếp
     * Hàm này quyết định việc chuyển token có thành công hay không
     */
    #[interface(spl_transfer_hook_interface::execute)]
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        // Kiểm tra xem hàm có được gọi trong ngữ cảnh chuyển token không
        // Đây là biện pháp bảo mật quan trọng để ngăn chặn việc gọi trực tiếp vào hàm này
        check_is_transferring(&ctx)?;

        // Kiểm tra xem địa chỉ đích có trong whitelist không
        // Nếu không có thì dừng giao dịch (transaction sẽ thất bại)
        if !ctx.accounts.white_list.white_list.contains(&ctx.accounts.destination_token.key()) {
            panic!("Account not in white list!");
        }

        // Log thông báo thành công nếu account đích nằm trong whitelist
        msg!("Account in white list, all good!");

        Ok(())
    }

    /*
     * Hàm thêm địa chỉ vào whitelist
     * 
     * Mục đích: Cho phép authority thêm một địa chỉ mới vào whitelist
     * Sau khi thêm, địa chỉ này sẽ có thể nhận được token thông qua chuyển token
     */
    pub fn add_to_whitelist(ctx: Context<AddToWhiteList>) -> Result<()> {
        // Kiểm tra xem người ký giao dịch có phải là authority của whitelist không
        // Đây là biện pháp bảo mật để đảm bảo chỉ authority mới có thể thay đổi whitelist
        if ctx.accounts.white_list.authority != ctx.accounts.signer.key() {
            panic!("Only the authority can add to the white list!");
        }

        // Thêm địa chỉ mới vào whitelist
        ctx.accounts.white_list.white_list.push(ctx.accounts.new_account.key());
        // Log thông tin về địa chỉ đã thêm
        msg!("New account white listed! {0}", ctx.accounts.new_account.key().to_string());
        // Log số lượng địa chỉ hiện có trong whitelist
        msg!("White list length! {0}", ctx.accounts.white_list.white_list.len());

        Ok(())
    }

    /*
     * Hàm xóa địa chỉ khỏi whitelist
     * 
     * Mục đích: Cho phép authority xóa một địa chỉ khỏi whitelist
     * Sau khi xóa, địa chỉ này không thể nhận được token thông qua chuyển token
     */
    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhiteList>) -> Result<()> {
        // Kiểm tra xem người ký giao dịch có phải là authority của whitelist không
        // Đây là biện pháp bảo mật để đảm bảo chỉ authority mới có thể thay đổi whitelist
        if ctx.accounts.white_list.authority != ctx.accounts.signer.key() {
            panic!("Only the authority can remove from the white list!");
        }

        // Lấy địa chỉ cần xóa
        let account_key = ctx.accounts.account_to_remove.key();
        // Tìm vị trí của địa chỉ trong whitelist
        // Sử dụng hàm position để tìm chỉ số của phần tử trong vector
        let position = ctx.accounts.white_list.white_list.iter().position(|x| *x == account_key);
        
        // Xử lý tùy theo kết quả tìm kiếm
        match position {
            // Nếu tìm thấy địa chỉ trong whitelist (Some chứa chỉ số)
            Some(index) => {
                // Xóa địa chỉ khỏi whitelist
                // remove() sẽ dịch chuyển các phần tử phía sau lên để duy trì tính liên tục của vector
                ctx.accounts.white_list.white_list.remove(index);
                // Log thông tin về địa chỉ đã xóa
                msg!("Account removed from whitelist: {0}", account_key.to_string());
                // Log số lượng địa chỉ còn lại trong whitelist
                msg!("White list length: {0}", ctx.accounts.white_list.white_list.len());
                Ok(())
            },
            // Nếu không tìm thấy địa chỉ trong whitelist (None)
            None => {
                // Log thông báo lỗi
                msg!("Account not found in whitelist: {0}", account_key.to_string());
                // Trả về lỗi AccountNotFound
                // Sử dụng err! macro để trả về lỗi một cách an toàn
                err!(TransferError::AccountNotFound)
            }
        }
    }
}

// PHẦN 6: HÀM HELPER
/*
 * Hàm kiểm tra trạng thái chuyển token
 * 
 * Đây là hàm helper để đảm bảo rằng hàm transfer_hook
 * chỉ được gọi bởi Token-2022 trong ngữ cảnh chuyển token
 * Đây là một biện pháp bảo mật quan trọng
 */
fn check_is_transferring(ctx: &Context<TransferHook>) -> Result<()> {
    // Lấy thông tin account token nguồn
    let source_token_info = ctx.accounts.source_token.to_account_info();
    // Mượn dữ liệu của account để đọc và chỉnh sửa
    let mut account_data_ref: RefMut<&mut [u8]> = source_token_info.try_borrow_mut_data()?;
    // Giải mã dữ liệu account thành cấu trúc PodAccount
    // PodStateWithExtensionsMut cho phép truy cập vào dữ liệu của account
    // và các extension của nó
    let mut account = PodStateWithExtensionsMut::<PodAccount>::unpack(*account_data_ref)?;
    // Lấy extension TransferHookAccount từ account
    // TransferHookAccount chứa trạng thái của quá trình chuyển token
    let account_extension = account.get_extension_mut::<TransferHookAccount>()?;

    // Kiểm tra trạng thái "transferring"
    // Nếu không phải đang chuyển token (transferring = false) thì báo lỗi
    // Điều này ngăn chặn việc gọi trực tiếp vào hàm transfer_hook
    if !bool::from(account_extension.transferring) {
        return err!(TransferError::IsNotCurrentlyTransferring);
    }

    Ok(())
}
