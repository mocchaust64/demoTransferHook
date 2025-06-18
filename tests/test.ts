import * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import {
ASSOCIATED_TOKEN_PROGRAM_ID,
ExtensionType,
TOKEN_2022_PROGRAM_ID,
createAssociatedTokenAccountInstruction,
createInitializeMintInstruction,
createInitializeTransferHookInstruction,
createMintToInstruction,
createTransferCheckedWithTransferHookInstruction,
getAssociatedTokenAddressSync,
getMintLen
} from '@solana/spl-token';
import { Keypair,SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { TransferHook } from './../target/types/transfer_hook';
import { publicKey } from '@coral-xyz/anchor/dist/cjs/utils';

describe('transfer_hook',() =>{
    
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.TransferHook as Program<TransferHook>;
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;
    const mint = Keypair.generate();
    const decimals =9 ;

    const sourceTokenAccount = getAssociatedTokenAddressSync(
        mint.publicKey,
        wallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const recipient = Keypair.generate();

    const destinationTokenAccount = getAssociatedTokenAddressSync(
        mint.publicKey,
        recipient.publicKey,false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const nonWhitelistedRecipient = Keypair.generate();
    const nonWhitelistedDestinationTokenAccount = getAssociatedTokenAddressSync(
        mint.publicKey,
        nonWhitelistedRecipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    )

    it ('create Mint Account with Transfer Hook Exttension', async() =>{
        const extension = ExtensionType.TransferHook;
        const mintLen  = getMintLen([extension]);
        const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

        const transaction = new Transaction().add(

            SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: mint.publicKey,
                space: mintLen,
                lamports,
                programId: TOKEN_2022_PROGRAM_ID
            }),
            createInitializeTransferHookInstruction(
                mint.publicKey,
                wallet.publicKey,
                program.programId,
                TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMintInstruction(
            mint.publicKey,
            decimals,
            wallet.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID

        ),
        );
        const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer, mint]);
        console.log (' Transsaction Signature:', txSig);
    });

    it ('create Token Account and Mint Token', async() =>{

    const amount = 100 *10 ** decimals;

    const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            sourceTokenAccount,
            wallet.publicKey,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID

        ),
        createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            destinationTokenAccount,
            recipient.publicKey,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            nonWhitelistedDestinationTokenAccount,
            nonWhitelistedRecipient.publicKey,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        ),
       
        createMintToInstruction(
            mint.publicKey,
            sourceTokenAccount,
            wallet.publicKey,
            amount,
            [],
            TOKEN_2022_PROGRAM_ID
        ),

    );

    const txSig = await sendAndConfirmTransaction(connection, transaction,[wallet.payer], {skipPreflight:  true});
    console.log('Transaction Signature:', txSig);
});

// create extraaccountMetaList 

it ('Create Extra Account Meta List', async() =>{

    const initializeExtraAccountMetaListInstruction = await program.methods
    .initializeExtraAccountMetaList()
    .accounts({
        mint: mint.publicKey
    })
    .instruction();

    const transaction = new Transaction().add(initializeExtraAccountMetaListInstruction);

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer],{skipPreflight:  true , commitment: 'confirmed'});

    console.log('Transaction Signature:', txSig);
});

it ('Add account to white list', async() =>{
    const addAccountToWhiteListInstruction = await program.methods
    .addToWhitelist()
    .accounts({
        newAccount: destinationTokenAccount,
        signer: wallet.publicKey,
    })
    .instruction();

    const transaction = new Transaction().add(addAccountToWhiteListInstruction);
    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {skipPreflight: true});
    console.log('Transaction Signature:', txSig);
})
 it ('Transfer hook with extera account meta - to whitelisted account', async() =>{
    const amount = 1 *10 ** decimals;
    const bigIntAmount = BigInt(amount);


    // tao transfer instruction voi transfer hook 

    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
        connection,
        sourceTokenAccount,
        mint.publicKey,
        destinationTokenAccount,
        wallet.publicKey,
        bigIntAmount,
        decimals,
        [],
        'confirmed',
        TOKEN_2022_PROGRAM_ID
    );

    const transaction = new Transaction().add(transferInstruction);
    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {skipPreflight: true});
     console.log('Transaction Signature:', txSig); 
 }
)

// test case: xoa tai khoan khoi  whitelist

it ('Remove account from white list', async() =>{
    const removeFromWhiteListInstruction = await program.methods
    .removeFromWhitelist() 
    .accounts({
        accountToRemove: destinationTokenAccount,
        signer: wallet.publicKey,
    })
    .instruction();

    const transaction = new Transaction().add(removeFromWhiteListInstruction);

    const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {skipPreflight: true});
    console.log('Transaction Signature:', txSig);


}) 

// test transfer cho token account da bi xoa trong whitelist

it ('Transfer hook with extera account meta - to removed account (should Faid)', async() =>{

    const amount = 1 * 10 **decimals;
    const bigIntAmount =  BigInt(amount);

    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
        connection,
        sourceTokenAccount,
        mint.publicKey,
        destinationTokenAccount, // token acoount vua xoa khoi white list
        wallet.publicKey,
        bigIntAmount,
        decimals,
        [],
        'confirmed',
        TOKEN_2022_PROGRAM_ID

    )
    // tao transaction
    const transaction = new  Transaction().add(transferInstruction);
    try{
        await sendAndConfirmTransaction(connection, transaction, [wallet.payer],{skipPreflight: true});
        throw new Error('Transfer should have failed but it succeeded');

    }catch(error: any){
        console.error(' Expected error - Transfer to Remove accoutnt failed :', error.message);

        
    }
    
})

// chuyen token den token account khong co trong white list


it ('Transfer hook with extera account meta - to removed account (should Faid)', async() =>{

    const amount = 1 * 10 **decimals;
    const bigIntAmount =  BigInt(amount);

    const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
        connection,
        sourceTokenAccount,
        mint.publicKey,
        nonWhitelistedRecipient.publicKey, // token acoount vua xoa khoi white list
        wallet.publicKey,
        bigIntAmount,
        decimals,
        [],
        'confirmed',
        TOKEN_2022_PROGRAM_ID

    )
    // tao transaction
    const transaction = new  Transaction().add(transferInstruction);
    try{
        await sendAndConfirmTransaction(connection, transaction, [wallet.payer],{skipPreflight: true});
        throw new Error('Transfer should have failed but it succeeded');

    }catch(error: any){
        console.error(' Expected error - Transfer to accoutnt  nonWhitelist  failed :', error.message);

        
    }
    
})



})

