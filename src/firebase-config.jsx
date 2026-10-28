import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAKt-zrxxyYSciltbCQNZtgPUEswemk6Dk",
  authDomain: "vapp-6db71.firebaseapp.com",
  projectId: "vapp-6db71",
  storageBucket: "vapp-6db71.firebasestorage.app",
  messagingSenderId: "188599117311",
  appId: "1:188599117311:web:83063e109f891c2d6ab3ca",
  measurementId: "G-RWJCWQ19LW"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Initialize and export services
export const auth = getAuth(app);
export const db = getFirestore(app);

export { app, analytics };
