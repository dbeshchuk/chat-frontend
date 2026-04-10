<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header><div class="fw-bold fs-5 py-1">Restore from shares</div> </template>
		<template #content>
			<div class="_full_width_block">
				<!-- TODO: PQ Backups - commented out Web3 features -->
				<!-- <RestoreFromShares @restore="setSecret" @account="setAccount" :key="updateKey" /> -->
				<div class="alert alert-info text-center">
					<h5>Coming Soon</h5>
					<p class="mb-0">Restore functionality for PQ accounts is under development.</p>
				</div>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
._full_width_block {
	max-width: 50rem;
	width: 100%;
}
</style>

<script setup>
import { ref, inject } from 'vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
// TODO: PQ Backups - commented out Web3 features
// import RestoreFromShares from '@/views/backup/RestoreFromShares.vue';

const secretText = ref();
// TODO: PQ Backups - commented out Web3 features
// const $user = inject('$user');
const $userPQ = inject('$userPQ');
// const $swal = inject('$swal');
// const $router = inject('$router');
const updateKey = ref(0);

// TODO: PQ Backups - commented out Web3 features
// const setSecret = async (s) => {
// 	secretText.value = s;
// };

// TODO: PQ Backups - commented out Web3 features
// const setAccount = async () => {
// 	updateKey.value++;
// 	secretText.value = null;
// 	$swal.fire({
// 		icon: 'success',
// 		title: 'Account restored',
// 		timer: 5000,
// 	});
// 	$router.replace({ name: 'account_info' });
// };
</script>
